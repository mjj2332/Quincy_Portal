# Quincy Portal — Google OAuth Setup

> **Purpose:** Create the Google OAuth client that staff use to sign in to Quincy Portal.
> **Who this is for:** Whoever has (or can get) admin access to a Google Cloud account for Quincy Productions.
> **You'll need:** A Google account to create the Cloud project in, and the values listed in "What to send back" once you're done.

---

## Background

Quincy Portal's staff sign-in is **Google OAuth only** — there's no separate username/password system. The app (via a library called better-auth) redirects staff to Google, Google confirms who they are, and Google redirects back to the app with that identity. This guide creates the Google-side "client" that makes that handshake possible.

Sign-in itself is a **closed system**: only staff whose email has already been added to the portal's database can actually log in, even if they successfully authenticate with Google. So creating this OAuth client doesn't open the door to the public — it just enables the login mechanism.

---

## Step 1 — Create or select a Google Cloud project

1. Go to https://console.cloud.google.com
2. Top bar → project dropdown → **New Project**
3. Name it something like "Quincy Portal" → **Create**
4. Once created, select it from the project dropdown so it's active.

---

## Step 2 — Configure the OAuth consent screen

1. Left menu → **APIs & Services → OAuth consent screen**
2. User type: **External** → **Create**
   - "External" just means "not restricted to a Google Workspace organization" — it does **not** mean the public can sign in. Access is still locked down inside the app (see Background above).
3. Fill in:
   - App name: **Quincy Portal**
   - User support email: your email
   - Developer contact email: your email
   - → **Save and Continue**
4. **Scopes** step: add these three scopes → **Save**
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`
5. **Test users** step: while the app is in "Testing" mode, only emails listed here can complete Google sign-in. Add every staff Google address you know now, and click **Publish App** once ready to remove that limit entirely.
   - Publishing does **not** require Google's verification review, because this app only requests the basic email/profile scopes above.

---

## Step 3 — Create the OAuth Client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: "Quincy Portal Web"
4. **Authorized JavaScript origins** — add each of these (one per line in the console):
   ```
   http://localhost:8787
   http://localhost:5173
   https://quincy.flamingfire.my
   ```
5. **Authorized redirect URIs** — add each of these:
   ```
   http://localhost:8787/api/auth/callback/google
   https://quincy.flamingfire.my/api/auth/callback/google
   ```
   > The path `/api/auth/callback/google` is fixed by how the app is built — don't change it unless told to.
6. Click **Create**.
7. A dialog shows the **Client ID** and **Client secret** — copy both somewhere safe immediately (the secret is only shown once in full; you can always view the Client ID again later, but you'd need to reset the secret if it's lost).

---

## Step 4 — Send the credentials back

Send back, via a secure channel (not plain email/Slack if avoidable — a password manager share or similar is better):

- **Client ID**
- **Client secret**

Do **not** commit these to git or paste them into any shared document. They'll be set as encrypted Cloudflare Worker secrets and as a local `.dev.vars` file that's already excluded from version control.

---

## Notes / things to flag if you run into them

- **`quincy.flamingfire.my` already serves something today.** If that's news to you, flag it back — the portal team needs to coordinate how it shares that domain (subdomain, path, or a fresh domain) before the production redirect URI above is actually usable. It doesn't block Steps 1–4; it only matters once someone deploys to production.
- If you don't have access to create a new Google Cloud project under the Quincy Productions organization, ask whoever manages Quincy's Google Workspace to either grant that access or create the project and hand you owner/editor rights on it.
- Keep the OAuth consent screen in **Testing** mode with an explicit test-user list until the team is ready — it's the simplest way to guarantee no unexpected sign-ins during setup.
