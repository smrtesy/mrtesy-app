# smrtesy — Data Security Policy

*How we protect the data and credentials you entrust to us.*

Last reviewed: 2026-08-05

---

## Our commitment

smrtesy connects to your email, messaging, calendar, and other accounts to do
useful work on your behalf. That access is a responsibility we take seriously.
This document describes, in plain terms, the technical controls we use to keep
your data and your connected-account credentials safe — including the controls
that limit our **own** staff and contractors.

---

## 1. Encryption of credentials at rest

Every third-party credential we hold on your behalf — access and refresh tokens
for Gmail, Drive, Calendar, WhatsApp, and any API keys — is stored **encrypted
at rest** using envelope encryption in a managed secrets vault.

- The database itself stores only an **encrypted reference**, never the raw
  secret. A database backup or snapshot, if it ever leaked, would expose
  **ciphertext only** — not a single usable token.
- The encryption keys are held by the managed vault, **outside** the
  application database, and are never checked into source code.

## 2. How secrets are used — and never shown

- Your credentials are decrypted **only at the moment the application needs to
  use them** (for example, to fetch new email during a sync), by the
  application runtime alone.
- **There is no screen, export, or admin tool that displays a stored
  credential back to a human** — not to you, not to our staff. Once a secret
  enters the vault, it is used by the system and never revealed again.
- Authentication passwords (where applicable) are protected with **one-way
  hashing**, which is mathematically irreversible: no one, including us, can
  recover the original — the system can only verify a login attempt against it.

## 3. Access control and least privilege

We operate on a strict least-privilege model with clearly separated roles:

| Role | Access |
|---|---|
| Organisation Owner | Full access to their own organisation's data and organisation-level keys |
| Manager / Member | Feature access scoped to what their role requires; personal data is private by default |
| Developer / Contractor | Application code and an **isolated development environment only** — **no production secrets, no production database key, no access to your personal data or credentials** |
| Platform Administrator | Platform-wide operational access, used only for support and infrastructure |

- **Developers and contractors never hold production credentials.** They work
  against an isolated environment with synthetic data. Even with full access to
  that environment, decryption of production secrets is technically impossible
  for them, because the decryption capability is restricted to the production
  application runtime alone.
- User management (adding, removing, or changing accounts) follows a strict
  hierarchy: a user can only manage accounts at or below their own level, and
  developers are excluded from user management entirely.

## 4. Environment isolation

Development and testing are performed in an environment **isolated from
production**, seeded with **synthetic data**. Your real data is never copied
into a developer's environment. Production secrets live only in production, in
managed secret stores — never in source code, and never on a developer's
machine.

## 5. Auditability — every access leaves a trace

- All access to sensitive data and credentials is **logged**, in records that
  cannot be silently altered by an application user.
- Every change to the system ships through **version-controlled, peer-reviewed
  code** and a **logged deployment** — there is no unlogged, ad-hoc path to your
  data.
- Automated monitoring raises an **alert** on anomalous access patterns (for
  example, bulk data reads or access to private records), reviewed on a daily
  cadence.

Our goal is not only that misuse is prevented, but that any attempt is
**detectable and attributable** — never silent.

## 6. Zero-operator-access — locking out even us

For clients whose requirements demand that **not even smrtesy's own owner or
staff can access their data**, we offer a dedicated deployment that removes the
final key from our sole control:

- Encryption keys are managed in an **external Key Management Service (KMS) /
  Hardware Security Module (HSM)** that we do not solely administer.
- Decryption requires **dual control (M-of-N approval)**, so no single
  individual — including our owner — can unilaterally access your data.

This tier is provided as a **dedicated, contractually-defined deployment** for
clients who require it. (In our standard deployment, decryption is restricted to
the application runtime and no human reveal path exists, but our operational
owner remains the ultimate key custodian — with every access logged and
tamper-evident as described in §5.)

## 7. Data ownership and deletion

Your data is yours. On request or account closure, we delete your data and
revoke and destroy the associated credentials from the secrets vault.

## 8. Questions

For security questions, audits, or to discuss a zero-operator-access
deployment, contact us at chanoch@maor.org.

---

*This policy describes our security architecture and controls. We review it
regularly and update it as our systems evolve.*
