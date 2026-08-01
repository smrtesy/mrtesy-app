#!/usr/bin/env bash
# Agent-run helper for the two-phase research protocol (CLAUDE.md rule 12,
# docs/pipeline.md § "פרוטוקול המחקר הדו-שלבי").
#
# The protocol is HARD-enforced by two hooks:
#   - research-gate.sh  (PreToolUse on WebSearch|WebFetch|Bash): no web research
#     without a *filled* research plan in .claude/research/active.json. Bash is
#     gated only for curl/wget against an external URL — production traffic
#     (queue.fal.run / fal.run / fal.media / proxy / localhost / backend) is not
#     research and is never gated.
#   - research-guard.sh (Stop): an open research plan blocks turn-end (up to
#     3x) until closure passes — every question answered/empirical, the
#     deliverable exists at its contract path, and the consumer check passed.
#
# Usage (agent actions):
#   research.sh start "<slug>"            # scaffold the plan file (phase 1)
#   research.sh check                     # validate the plan is complete
#   research.sh answer <i> answered|empirical "<evidence>"   # mark question i (0-based)
#   research.sh consumer-pass "<note>"    # record the consumer check passed
#
# Evidence is mandatory (rule 5 in enforcement, not prose): every resolved
# question carries its source, and a CONTRACT FACT — an endpoint id, field name,
# enum or default, marked contract:true or with a schema-ish source — must cite a
# machine-readable schema URL. `close` refuses otherwise, which is what stops a
# field invented from marketing copy from being reported as verified.
#   research.sh close                     # validate closure + archive the plan
#   research.sh abandon "<reason>"        # user-authorized abort (logged loudly)
#   research.sh waive "<reason>" [n]      # allow n one-off non-research fetches
#   research.sh show                      # print the active plan
#
# Guarded no-op (exit 0) on any error / missing jq — never fails a turn.
set -uo pipefail

command -v jq >/dev/null 2>&1 || { echo "research: jq missing — skipped"; exit 0; }

# Anchored on the project root, not the cwd: research.sh is run by the agent from
# wherever it happens to be, and a relative .claude/research would silently write
# a second, invisible plan under any subdirectory.
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
DIR="$ROOT/.claude/research"
PLAN="$DIR/active.json"
WAIVER="$DIR/waiver.count"
WLOG="$DIR/waivers.log"
GUARD_COUNT="$DIR/guard.count"
mkdir -p "$DIR" 2>/dev/null || true

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Validation shared with research-gate.sh: a plan is COMPLETE when every core
# field is filled (no TODO markers) and there is at least one question, each
# with a non-empty q + source. Prints nothing and returns 0 when complete;
# prints the missing pieces and returns 1 otherwise.
validate_plan() {
  [ -f "$PLAN" ] || { echo "MISSING: אין קובץ תוכנית ($PLAN) — הרץ: .claude/hooks/research.sh start \"<slug>\""; return 1; }
  jq empty "$PLAN" 2>/dev/null || { echo "MISSING: $PLAN אינו JSON תקין"; return 1; }
  local bad=0
  for f in decision consumer output_path stop_condition; do
    v="$(jq -r ".$f // \"\"" "$PLAN" 2>/dev/null)"
    case "$v" in ""|*TODO*) echo "MISSING: השדה '$f' ריק או עדיין TODO"; bad=1;; esac
  done
  qn="$(jq -r '.questions | length' "$PLAN" 2>/dev/null || echo 0)"
  if [ "${qn:-0}" -lt 1 ] 2>/dev/null; then echo "MISSING: אין אף שאלת-מחקר ב-questions"; bad=1; fi
  nbad="$(jq -r '[.questions[]? | select((.q // "" | . == "" or contains("TODO")) or (.source // "" | . == "" or contains("TODO")))] | length' "$PLAN" 2>/dev/null || echo 0)"
  if [ "${nbad:-0}" -gt 0 ] 2>/dev/null; then echo "MISSING: $nbad שאלות עם q/source ריקים או TODO"; bad=1; fi
  return $bad
}

CMD="${1:-}"; shift || true

case "$CMD" in
  start)
    SLUG="${1:-research}"
    if [ -f "$PLAN" ] && [ "$(jq -r '.status // ""' "$PLAN" 2>/dev/null)" = "open" ]; then
      echo "research: כבר קיימת תוכנית-מחקר פתוחה ($(jq -r '.slug' "$PLAN" 2>/dev/null)). סגור אותה (close) או נטוש (abandon) לפני שמתחילים חדשה."
      exit 0
    fi
    jq -n --arg slug "$SLUG" --arg c "$(now_iso)" \
      '{slug:$slug, status:"open",
        decision:"TODO: ההחלטה שהמחקר משרת (מי מחליט מה על סמך התשובות)",
        consumer:"TODO: מי צורך את התוצר (איזה סקיל/משימה קוראים אותו)",
        questions:[{q:"TODO: שאלת מחקר 1 (רשימה סגורה)", source:"TODO: המקור המוסמך שייבדק",
                    status:"open", evidence:"", contract:false}],
        not_researching:"TODO: מה במפורש לא חוקרים (גבולות)",
        output_path:"TODO: הנתיב המדויק ממפת התוצרים (docs/pipeline.md)",
        stop_condition:"TODO: תנאי עצירה (תקרת מושב/עומק)",
        consumer_check:"pending",
        created_at:$c, updated_at:$c}' > "$PLAN" 2>/dev/null || { echo "research: כתיבת התוכנית נכשלה"; exit 0; }
    rm -f "$GUARD_COUNT" 2>/dev/null || true
    echo "research: שלד תוכנית-מחקר נכתב → $PLAN"
    echo "שלב 1 (לפני כל חיפוש): מלא את כל שדות ה-TODO — ההחלטה, הצרכן, שאלות"
    echo "המחקר (רשימה סגורה, מקור מוסמך לכל שאלה), מה לא חוקרים, נתיב-התוצר"
    echo "ממפת התוצרים, ותנאי עצירה. ואז הרץ: .claude/hooks/research.sh check"
    echo "חיפושי רשת חסומים עד שהתוכנית מלאה (research-gate)."
    echo "עובדת-חוזה (endpoint / שם-שדה / enum / ברירת-מחדל) → סמן בשאלה contract:true;"
    echo "הסגירה תדרוש שה-evidence שלה יכלול קישור לסכמה מכונה-קריאה (כלל 5)."
    ;;

  check)
    if OUT="$(validate_plan)"; then
      echo "research: OK — התוכנית מלאה. אפשר לחקור (שלב 2). זכור: רוחב לפני עומק; ≥2 מקורות לטענה מכרעת; סתירות מוצפות."
    else
      echo "$OUT"
      echo "research: התוכנית עדיין לא מלאה — השלם את השדות שלמעלה."
    fi
    ;;

  answer)
    IDX="${1:-}"; ST="${2:-answered}"; EV="${3:-}"
    case "$ST" in answered|empirical) ;; *) echo "research: סטטוס חייב להיות answered או empirical"; exit 0;; esac
    case "$IDX" in ''|*[!0-9]*) echo "research: answer צריך אינדקס שאלה (0-based)"; exit 0;; esac
    [ -f "$PLAN" ] || { echo "research: אין תוכנית פעילה"; exit 0; }
    if [ -z "$EV" ]; then
      echo "research: answer דורש אסמכתא — קישור/ציטוט למקור, או תיאור הבדיקה האמפירית."
      echo "  שימוש: research.sh answer <i> answered|empirical \"<אסמכתא>\""
      echo "  עובדת-חוזה (contract:true): האסמכתא חייבת לכלול קישור לסכמה —"
      echo "  https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>"
      exit 0
    fi
    TMP="$(jq --argjson i "$IDX" --arg s "$ST" --arg e "$EV" --arg u "$(now_iso)" \
      '.questions[$i].status=$s | .questions[$i].evidence=$e | .updated_at=$u' "$PLAN" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$PLAN" && echo "research: שאלה $IDX סומנה $ST (עם אסמכתא)." || echo "research: עדכון נכשל (אינדקס קיים?)"
    ;;

  consumer-pass)
    NOTE="${1:-}"
    [ -f "$PLAN" ] || { echo "research: אין תוכנית פעילה"; exit 0; }
    [ -z "$NOTE" ] && { echo "research: consumer-pass דורש תיאור — מה נבדק מול הצרכן ואיך אומת שהוא פועל בלי לנחש"; exit 0; }
    # The note must point at something that exists — a free-text "checked, all
    # good" is exactly the attestation that made this step skippable.
    HIT=0
    case "$NOTE" in *http://*|*https://*) HIT=1 ;; esac
    if [ "$HIT" = "0" ]; then
      set -f                      # word-split the note, never glob it
      for tok in $NOTE; do
        tok="${tok%[.,;:)]}"; tok="${tok#(}"
        case "$tok" in /*) cand="$tok" ;; *) cand="$ROOT/$tok" ;; esac
        if [ -e "$cand" ]; then HIT=1; break; fi
      done
      set +f
    fi
    if [ "$HIT" = "0" ]; then
      echo "research: ההערה לא מצביעה על צרכן קיים — כתוב בה את הנתיב לסקיל/המשימה שפתחת (או קישור)."
      echo "  דוגמה: consumer-pass \".claude/skills/test-a/SKILL.md — הצעד הראשון מצא מדורג-ראשון חד-משמעי ב-shortlist-image.json\""
      exit 0
    fi
    TMP="$(jq --arg n "$NOTE" --arg u "$(now_iso)" \
      '.consumer_check="passed" | .consumer_check_note=$n | .updated_at=$u' "$PLAN" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$PLAN" && echo "research: בדיקת-הצרכן סומנה passed."
    ;;

  close)
    [ -f "$PLAN" ] || { echo "research: אין תוכנית פעילה — אין מה לסגור."; exit 0; }
    FAIL=0
    if ! OUT="$(validate_plan)"; then echo "$OUT"; FAIL=1; fi
    OPENQ="$(jq -r '[.questions[]? | select(.status=="open")] | length' "$PLAN" 2>/dev/null || echo 1)"
    if [ "${OPENQ:-1}" -gt 0 ] 2>/dev/null; then
      echo "CLOSE-FAIL: $OPENQ שאלות עדיין open — סמן כל אחת answered (עם מקור בתוצר) או empirical (research.sh answer <i> <status>)."
      FAIL=1
    fi
    NOEV="$(jq -r '[.questions[]? | select(((.status // "open") != "open") and (((.evidence // "") | test("\\S")) | not))] | length' "$PLAN" 2>/dev/null || echo 0)"
    if [ "${NOEV:-0}" -gt 0 ] 2>/dev/null; then
      echo "CLOSE-FAIL: $NOEV שאלות נענו בלי אסמכתא — כל תשובה נושאת את מקורה: research.sh answer <i> <status> \"<קישור/ציטוט או תיאור הבדיקה האמפירית>\"."
      FAIL=1
    fi
    # THE contract-facts check (CLAUDE.md rule 5): a question marked contract:true —
    # or whose source names a schema — must cite a machine-readable schema URL.
    # Without this the protocol closes cleanly on fields taken from marketing prose.
    BADSCHEMA="$(jq -r '[.questions[]?
        | select(((.contract // false) == true) or ((.source // "") | test("openapi|schema|סכמה"; "i")))
        | select(((((.evidence // "") | test("https?://")) and ((.evidence // "") | test("openapi|schema|[.]json"; "i")))) | not)] | length' "$PLAN" 2>/dev/null || echo 0)"
    if [ "${BADSCHEMA:-0}" -gt 0 ] 2>/dev/null; then
      echo "CLOSE-FAIL: $BADSCHEMA עובדות-חוזה בלי קישור לסכמה מכונה-קריאה (כלל 5) — endpoint / שם-שדה / enum / ברירת-מחדל נלקחים מ-https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id> בלבד, והקישור נשמר ב-evidence. שאלה שאינה עובדת-חוזה — הסר ממנה contract:true ונסח source בלי 'schema'."
      FAIL=1
    fi
    OUTP="$(jq -r '.output_path // ""' "$PLAN" 2>/dev/null)"
    case "$OUTP" in /*) OUTABS="$OUTP" ;; *) OUTABS="$ROOT/$OUTP" ;; esac
    if [ -z "$OUTP" ] || [ ! -e "$OUTABS" ]; then
      echo "CLOSE-FAIL: התוצר לא קיים בנתיב-החוזה '$OUTP' — שמור אותו שם בדיוק (מפת התוצרים, docs/pipeline.md)."
      FAIL=1
    fi
    CC="$(jq -r '.consumer_check // "pending"' "$PLAN" 2>/dev/null)"
    if [ "$CC" != "passed" ]; then
      echo "CLOSE-FAIL: בדיקת-הצרכן לא בוצעה — פתח את הסקיל/המשימה הצורכים, ודא שהם פועלים מהתוצר בלי לנחש, והרץ: .claude/hooks/research.sh consumer-pass \"<מה נבדק>\""
      FAIL=1
    fi
    if [ "$FAIL" -ne 0 ]; then
      echo "research: הסגירה נדחתה — המחקר לא גמור עד שהכל למעלה מתוקן."
      exit 0
    fi
    SLUG="$(jq -r '.slug // "research"' "$PLAN" 2>/dev/null)"
    TS="$(date -u +%Y%m%d-%H%M%S)"
    TMP="$(jq --arg u "$(now_iso)" '.status="closed" | .closed_at=$u' "$PLAN" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$DIR/closed-${SLUG}-${TS}.json"
    rm -f "$PLAN" "$GUARD_COUNT" 2>/dev/null || true
    echo "research: המחקר נסגר כדין ✔ (ארכיון: $DIR/closed-${SLUG}-${TS}.json)"
    echo "עוד שני צעדי-סגירה שאינם ניתנים לאימות מכני — בצע אותם עכשיו:"
    echo "  1. **הצג את הדוח בצ'אט** — התזכיר ($OUTP) מוצג למשתמש בגוף התשובה"
    echo "     (ההמלצה בראש + הממצאים + מה נסגר), לא רק נשמר. המשתמש לא צריך לחפש."
    echo "  2. **דווח לכרטיס המשימה** — .claude/hooks/post-session-summary.sh"
    echo "     \"<נושא>\" \"<סיכום + קישור לתזכיר>\" \"<הצעד הבא>\" (אם המשימה מסומנת"
    echo "     'בעבודה' הדיווח נצמד לכרטיס; אחרת נופל להצעה בתיבה)."
    echo "  3. ודא שהתוצר ב-$OUTP מגיע לענף הקנוני (main) — בלי זה הוא לא קיים מבחינת הצינור."
    ;;

  abandon)
    REASON="${1:-}"
    [ -f "$PLAN" ] || { echo "research: אין תוכנית פעילה."; exit 0; }
    [ -z "$REASON" ] && { echo "research: abandon דורש סיבה מפורשת (ורק באישור המשתמש)."; exit 0; }
    SLUG="$(jq -r '.slug // "research"' "$PLAN" 2>/dev/null)"
    TS="$(date -u +%Y%m%d-%H%M%S)"
    TMP="$(jq --arg r "$REASON" --arg u "$(now_iso)" '.status="abandoned" | .abandon_reason=$r | .closed_at=$u' "$PLAN" 2>/dev/null || true)"
    [ -n "$TMP" ] && printf '%s\n' "$TMP" > "$DIR/abandoned-${SLUG}-${TS}.json"
    rm -f "$PLAN" "$GUARD_COUNT" 2>/dev/null || true
    echo "research: ⚠️ המחקר ננטש (לא הושלם): $REASON"
    echo "research: נרשם ב-$DIR/abandoned-${SLUG}-${TS}.json — דווח על כך למשתמש במפורש."
    ;;

  waive)
    REASON="${1:-}"; N="${2:-1}"
    case "$N" in ''|*[!0-9]*) N=1;; esac
    [ "$N" -gt 5 ] 2>/dev/null && N=5
    [ -z "$REASON" ] && { echo "research: waive דורש סיבה — למה הקריאה הזו אינה מחקר."; exit 0; }
    echo "$N" > "$WAIVER"
    echo "$(now_iso) waive n=$N reason=$REASON" >> "$WLOG"
    echo "research: ⚠️ אושרו $N קריאות רשת חד-פעמיות ללא תוכנית-מחקר. הסיבה נרשמה ב-$WLOG:"
    echo "  \"$REASON\""
    echo "אם זה בעצם מחקר — עצור והרץ research.sh start במקום."
    ;;

  show)
    [ -f "$PLAN" ] && cat "$PLAN" || echo "NO_ACTIVE_RESEARCH"
    ;;

  *)
    echo "research: unknown command '${CMD:-}'. Use: start | check | answer | consumer-pass | close | abandon | waive | show"
    ;;
esac
exit 0
