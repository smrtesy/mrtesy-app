import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendInviteEmail({
  to,
  orgName,
  inviteUrl,
  locale = "he",
}: {
  to: string;
  orgName: string;
  inviteUrl: string;
  locale?: string;
}) {
  const isHe = locale === "he";
  const subject = isHe
    ? `הוזמנת להצטרף ל-${orgName} ב-smrtTask`
    : `You've been invited to join ${orgName} on smrtTask`;

  const body = isHe
    ? `<div dir="rtl" style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2>הוזמנת להצטרף ל-${escapeHtml(orgName)}</h2>
        <p>לחץ על הכפתור להלן כדי לאשר את ההזמנה ולהתחבר עם Google:</p>
        <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:12px 24px;background:#1E4D8C;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">
          אשר הזמנה
        </a>
        <p style="color:#888;font-size:12px">הקישור יפוג תוך 7 ימים.</p>
      </div>`
    : `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2>You've been invited to join ${escapeHtml(orgName)}</h2>
        <p>Click the button below to accept your invitation and sign in with Google:</p>
        <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:12px 24px;background:#1E4D8C;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">
          Accept Invitation
        </a>
        <p style="color:#888;font-size:12px">This link expires in 7 days.</p>
      </div>`;

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "smrtTask <noreply@smrtesy.com>",
    to,
    subject,
    html: body,
  });

  if (error) throw new Error(`Failed to send invite email: ${error.message}`);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
