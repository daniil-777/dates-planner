# XSUAA and Cloud Identity Services — auth for a private, few-user app

The default deployment (Fly.io, `docs/DEPLOY.md`) authenticates with HTTP basic
auth over HTTPS against two bcrypt hashes in the environment:
`AUTH_USER_A` / `AUTH_HASH_A` and `AUTH_USER_B` / `AUTH_HASH_B`, generated with
`npm run hash`. For a household and one private app that is proportionate,
auditable in one paragraph, and has no moving parts.

This document is the other option: authenticating through **SAP BTP's XSUAA**
with **Cloud Identity Services** as the identity provider, which is what you do
when the app is deployed to Cloud Foundry on BTP. It is worth setting up for one
reason beyond correctness — it is the identity stack every SAP customer runs, so
the login screen, the role collection, and the "you are not assigned to any role"
error are all things a customer-facing SAP person recognises on sight.

Scope of this document: **one role, `Member`, one role collection, everybody in
the household.** Anything more elaborate would be modelling a privilege boundary
that does not exist between people who share a bank account.

---

## 1. How the pieces fit

```
browser ──login──▶ XSUAA ──delegates──▶ Cloud Identity Services (or SAP ID Service)
   │                 │
   │  ◀──── JWT ─────┘
   ▼
approuter  ──JWT in Authorization header──▶  CAP (srv)  ──▶  People row
 (@sap/approuter)                          validates the JWT,
 owns the login flow                       reads scopes + attributes
 and the session cookie
```

- **XSUAA** is the OAuth 2.0 authorization server. It does not store users; it
  trusts an identity provider and issues JWTs containing _scopes_.
- **Cloud Identity Services (IAS)** — or the default _SAP ID Service_ on a trial
  — holds the actual users and does the password/MFA part.
- The **approuter** is the only thing exposed to the internet. It handles the
  redirect dance, keeps the session cookie, and forwards requests to CAP with a
  `Bearer` JWT.
- **CAP** validates the JWT against XSUAA's public key and turns it into
  `req.user`: `req.user.id` (the principal), `req.user.is('Member')`,
  `req.user.attr.*`.

CAP never sees a password. That is the entire point.

---

## 2. `xs-security.json`

CAP can generate this from the `@requires` annotations in the service
(`cds compile srv --to xsuaa > xs-security.json`), and `cds add xsuaa` scaffolds
it. Generate it once, then keep the file — it is the security contract and it
belongs in review, not in a build step.

```jsonc
{
  "xsappname": "twoway-match",
  "tenant-mode": "dedicated",
  "description": "Two-Way Match — spend management for a household",

  "scopes": [
    {
      "name": "$XSAPPNAME.Member",
      "description": "Full access to the shared ledger",
    },
  ],

  "role-templates": [
    {
      "name": "Member",
      "description": "Somebody who shares this ledger",
      "scope-references": ["$XSAPPNAME.Member"],
    },
  ],

  "role-collections": [
    {
      "name": "TwoWayMatch_Member",
      "description": "Assign to everybody in the household",
      "role-template-references": ["$XSAPPNAME.Member"],
    },
  ],

  "oauth2-configuration": {
    "redirect-uris": ["https://*.cfapps.eu10.hana.ondemand.com/**", "http://localhost:5000/**"],
    "token-validity": 43200,
    "refresh-token-validity": 2592000,
  },
}
```

Notes that are not obvious from the file:

- **`xsappname` must be unique per subaccount**, and CF appends `!t<id>` to make
  it globally unique. If a deploy fails with "xsappname already exists", another
  instance in the same subaccount claimed it — bump it (`twoway-match-2`) or
  delete the old service instance. Renaming it invalidates every issued token and
  every existing role-collection assignment, so do it before you hand out logins,
  not after.
- **`tenant-mode: dedicated`** because this is a single-tenant app. `shared`
  turns on subdomain-based multitenancy you do not want.
- **`redirect-uris` needs the `/**` suffix**, and the wildcard host form for CF.
  A missing entry does not produce an error page — it produces a redirect loop
  through the login screen, which is a much worse way to spend twenty minutes.
  Add the `localhost` entry only while you are testing hybrid mode; drop it
  before go-live.
- There are deliberately **no attributes**. Which row in `People` a login is
  comes from the email in the token, not from a letter stamped on the user (see
  §5): the ledger has no fixed number of people, so there is no small closed set
  of values an attribute could carry.
- There is deliberately **no `Admin` scope**. The one protected action,
  `reloadModel()`, is `@requires: 'Member'` like everything else and is simply
  not surfaced in the UI. With a handful of users who all own all the data, a
  role hierarchy would be theatre.

### In the service

```cds
service LedgerService @(path: '/ledger', requires: 'Member') {
  // …
}
```

and, in production, CAP's auth strategy:

```jsonc
// package.json → cds → requires
{
  "auth": {
    "[production]": { "kind": "xsuaa" },
    "[development]": { "kind": "mocked" },
  },
}
```

---

## 3. Create the instance

Via the MTA (recommended — it is `docs/DEPLOY.md`'s path B):

```yaml
resources:
  - name: twoway-uaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json
```

Or by hand, which is useful when you are iterating on the JSON:

```bash
cf create-service xsuaa application twoway-uaa -c xs-security.json
# after editing xs-security.json:
cf update-service twoway-uaa -c xs-security.json
```

`cf update-service` republishes the scopes and role templates. Existing role
collections keep their assignments, but **already-issued JWTs keep their old
scopes until they expire** — so after a scope change, log out and back in
before concluding that it did not work.

---

## 4. Trust, users, and the one assignment step

### Trust configuration

Cockpit → your subaccount → **Security → Trust Configuration**.

- On a **trial**, `sap.default` (SAP ID Service) is there already. Anyone with an
  SAP account can be assigned, which is fine for a handful of people you know.
- With **Cloud Identity Services**: subscribe to _Cloud Identity Services_ in the
  Service Marketplace, then **Trust Configuration → Establish Trust**, pick your
  IAS tenant, and give it a name. Set _Available for User Logon_ on the IAS entry
  and consider switching `sap.default` to _not_ available for logon, so the login
  screen does not offer two identity providers to a household of two.
- In the IAS admin console (`https://<tenant>.accounts.ondemand.com/admin`) →
  **Users & Authorizations → User Management → Add User** for each person. IAS
  is also where you would turn on TOTP, which for an app holding a year of
  receipts is a reasonable twenty seconds of setup.

### Assign the role collection

Cockpit → subaccount → **Security → Role Collections** →
**TwoWayMatch_Member** → _Edit_ → **Users**:

| Field             | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| ID / E-Mail       | that person's login email                                    |
| Identity Provider | the IdP you just configured (or _Default identity provider_) |

Add everybody who is going to sign in. The email is the whole mapping — make it
the same address as their `People.email` row (§5).

**This is the step everyone forgets.** A user who authenticates successfully but
has no role collection gets a **403** from CAP, not a 401, with a body that says
nothing useful. Symptom-to-cause: 401 = the token is missing/invalid/expired;
403 = the token is fine and the scope is not in it.

---

## 5. Mapping a principal onto the `People` entity

The token knows an email. The app needs a `People` row — every expense has a
`paidBy` association and the UI colours avatars from `People.colour`. The bridge
is `People.email` (`docs/CONTRACTS.md` §10).

The seed data ships placeholders — `Partner A` / `Partner B` — and every row is
editable at runtime through Settings → Onboarding, where more people can be added
at any time. Before you switch on XSUAA, set each row's `email` to the exact login
the IdP will send.

Resolution, in the service's `before('*')` hook, is one lookup:

1. Match `req.user.id` against `People.email`, **case-insensitively** — IdPs are
   inconsistent about the case of the local part, and `Anna@example.com` failing
   to match `anna@example.com` is a spectacularly boring bug to debug.
2. **No match?** `req.reject(403, 'Not a registered person')`. Do not auto-create
   a row: people are added deliberately, in Settings, and an auth misconfiguration
   must fail loudly rather than quietly inventing somebody in the ledger.

There is no attribute step. The household has no fixed size, so there is no small
set of letters a token could carry — the email is the identity and the only thing
worth matching on.

The shape of it:

```ts
/** Resolve a JWT principal to the `People` row it belongs to.
 *
 *  A token carries an identity; every write needs a row. The match is case-folded
 *  on **both** sides, since IdPs are inconsistent about the case of the local
 *  part. `lower()` on the column, not `.toLowerCase()` on the value alone:
 *  folding one side only is the bug this line exists to prevent. */
async function resolvePerson(user: { id: string }) {
  const login = user.id.toLowerCase()
  return await SELECT.one.from(People).where`lower(email) = ${login}`
}

srv.before('*', async req => {
  if (!(await resolvePerson(req.user))) req.reject(403, 'Not a registered person')
})
```

The `before('*')` hook only enforces membership; handlers that actually need the
row call `resolvePerson(req.user)` themselves. That is deliberate — stashing the
result on `req.data` does not work (a `READ` carries no `data`, and an unmodelled
property is dropped before a handler sees it), and a process-wide cache would go
stale the moment Settings → Onboarding edits a row. One row behind a primary key
is a read you can afford.

Two consequences worth stating:

- **`req.user.id` is never stored on a row.** Expenses reference `People.ID`.
  Changing an identity provider, or an email address, then costs one `UPDATE` on
  a `People` row and rewrites no history.
- **`Corrections` and `Settlements.approvedBy` stay human strings.**
  `approvedBy` is `'CEO of the household'` because that is the joke; it is not an
  authorization decision and must not become one.

---

## 6. Local development

Production auth must never be the thing you test against by hand. In dev, CAP's
mocked auth gives you the seeded logins without a login screen:

```jsonc
// package.json → cds → requires → auth (development profile)
{
  "kind": "mocked",
  "users": {
    "partner-a@example.com": { "roles": ["Member"] },
    "partner-b@example.com": { "roles": ["Member"] },
  },
}
```

Requests then authenticate with plain basic auth and any password, and the
avatar switcher in the shell bar picks which one you are.

To test against the **real** XSUAA without deploying, use CAP's hybrid profile:

```bash
cf create-service-key twoway-uaa twoway-uaa-key
cds bind -2 twoway-uaa                  # writes .cdsrc-private.json, git-ignored
cds watch --profile hybrid
```

That validates real tokens locally, which is the only way to catch a
`redirect-uris` or `xsappname` mistake before it is a deployed login loop.

---

## 7. Troubleshooting

| Symptom                                                | Cause                                                                       | Fix                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Redirect loop through the login screen                 | the app's URL is not in `oauth2-configuration.redirect-uris`                | Add `https://<host>/**`; `cf update-service`; **restage** the approuter.                                              |
| Login works, every request is `403`                    | role collection not assigned, or assigned under the wrong identity provider | Security → Role Collections → _TwoWayMatch_Member_ → Users; check the IdP column matches the one you logged in with. |
| `403` immediately after adding the role collection     | the JWT was issued before the assignment and still has the old scopes       | Log out, clear the approuter session cookie, log in again.                                                            |
| `401 Unauthorized` from CAP with a valid-looking token | CAP bound to a different XSUAA instance than the token was issued by        | One `twoway-uaa` instance, bound to both the CAP app and the approuter. Check `VCAP_SERVICES`.                        |
| Deploy fails: "xsappname already exists"               | another instance in the subaccount claimed it                               | Delete the stale service instance or change `xsappname` — before handing out logins.                                  |
| `403 Not a registered person`                          | `People.email` still holds the placeholder value                            | Settings → Onboarding, or fix `db/data/twowaymatch-People.csv` and redeploy.                                          |
| Scope changes have no effect                           | `cf update-service` ran but the app was not restaged                        | `cf restage` the CAP app and the approuter.                                                                           |
| Everything works, then stops after ~12 h               | token validity elapsed and the refresh token was rejected                   | Expected on a laptop left open; re-login. If it happens hourly, check `token-validity`.                               |
