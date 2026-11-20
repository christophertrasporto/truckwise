# Putting Truckwise on the internet

Code on **GitHub**, database on **Supabase**, the app on **Railway**, your domain's settings on **Hostinger**.
Do the steps in order. Nothing here costs anything until you pick a paid plan; expect roughly 5 to 20 USD a month in total.

> Status: the app is prepared for this setup, but it has **not been deployed or tested against Supabase or Railway yet**.
> The first deploy may need a small fix. Keep the Railway deploy logs open and send me anything that fails.

## 0. Before you start

- Change your own administrator password (Account page). Pick a long one that is not your email address.
- The sample companies and logins made during development live only on your computer's test database. The live site starts empty, so nothing from them carries over.
- Decide the address people will use, for example `app.yourdomain.com` (a subdomain is easiest on Hostinger).

## 1. GitHub: store the code

1. On github.com click **New repository**. Name it `truckwise`. Choose **Private**. Do not add a README.
2. Tell me when it exists. I will make the first commit and give you the two commands that send the code to it.
3. Never put real passwords in the code. They go in Railway (step 3). The file `.env` is ignored by git on purpose.

## 2. Supabase: the database

1. supabase.com, **New project**. Region **Southeast Asia (Singapore)**. Save the database password it asks you to set.
2. When it is ready, click **Connect** at the top. Copy the **Session pooler** connection string (it uses port 5432).
   Use the pooler, not "Direct connection": Railway cannot reach Supabase's direct address.
3. Turn off the Data API: **Project Settings, Data API**, switch it off (or "Exposed schemas" empty). Truckwise never uses it,
   and leaving it on adds a second way into your data. The deploy also removes its permissions as a second layer.
4. You now have the pieces for these two lines (see `.env.production.example`):
   - `DATABASE_ADMIN_URL`: the pooler string with user `postgres.<project-ref>` and your database password, plus `?sslmode=require`.
   - `DATABASE_URL`: the same string but the user is `smartload_app.<project-ref>` and the password is a **new long random one you invent**.
   - `APP_DB_PASSWORD`: that same invented password. The deploy creates the restricted `smartload_app` user with it.

## 3. Railway: run the app

1. railway.com, **New Project, Deploy from GitHub repo**, choose `truckwise`. Pick the **Singapore** region when asked.
2. Open the service, **Variables**, and paste every line from `.env.production.example`, filled in:
   - Generate the signing secret on your computer: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `OWNER_NAME`, `OWNER_EMAIL`, `OWNER_PASSWORD` are your first owner login (used once, in step 5).
3. **Add a Volume** (service, Settings or the Command Palette, "Volume") and mount it at `/data`. This keeps uploaded photos and
   documents when the app is redeployed. Without it, files disappear on every deploy.
4. Deploy. Railway builds the app, runs the database changes (`npm run db:migrate:live`), then starts it. The health check is `/api/health`.
5. If the server refuses to start with "Unsafe live configuration", it is telling you which variable is wrong. Fix it and redeploy.

## 4. Hostinger: point your domain at Railway

This assumes your domain is registered with, or its DNS managed by, Hostinger.
Plain Hostinger web hosting cannot run this app; only the domain's DNS settings are used here.

1. In Railway: service, **Settings, Networking, Custom Domain**, enter `app.yourdomain.com`.
   Railway shows a **CNAME target** (something like `xxxx.up.railway.app`) and sometimes a **TXT** record to prove ownership.
2. In Hostinger: **hPanel, Domains, your domain, DNS / Nameservers, DNS records**.
3. Add a record:
   - Type **CNAME**, Name **app** (Hostinger adds the rest of the domain), Target the value Railway gave you, TTL 300.
4. If Railway also showed a **TXT** record, add it exactly as shown (Name and Value copied from Railway).
5. If a record for `app` already exists (an A or CNAME), delete it first; a name can only point one place.
6. Wait. It is usually a few minutes, up to a few hours. Railway shows a green tick when it has found the record and then
   issues the HTTPS certificate by itself.
7. Open `https://app.yourdomain.com/login`. You should see the lock icon.

Using the bare domain (`yourdomain.com`, with no `app.`) is harder on Hostinger because it cannot point a root name at another
service. The two ways around it are to use a subdomain, or to move the domain's nameservers to Cloudflare (free) and use its
"flattened CNAME". Ask me before choosing that.

## 5. Create your owner login on the live site

The simplest way is from your own computer, pointed at the Supabase database. In PowerShell, in the project folder, set
`DATABASE_ADMIN_URL`, `COMPANY_NAME`, `OWNER_NAME`, `OWNER_EMAIL` and `OWNER_PASSWORD` (for example `$env:OWNER_EMAIL = "you@example.com"`)
and run `npm run db:seed:live`. It creates the company and the owner login. Close the PowerShell window afterwards so the
password is not left behind. Sign in at your address and change the password on the Account page.

To add your platform-administrator access (the Platform menu), tell me and I will give you the one safe command for it.

## 6. Check it, then invite people

- Sign in, add a client, a truck and a team member. Upload a photo (this proves the volume works).
- Open the subcontractor application link from a phone, on mobile data, and submit a test application.
- Supabase, **Database, Backups**: confirm daily backups are on. (Free plans have none; the Pro plan does. Use Pro before real money flows through.)

## What is still open before opening it to other companies

- No "forgot password" email yet; an administrator resets passwords.
- Email, text-message and push credentials are not connected (alerts stay inside the app until you add providers).
- The malware scanner is a stub. A real scanner (ClamAV) is not connected.
- Terms and a privacy policy are needed before strangers sign up (Philippine Data Privacy Act).
- Custom domains and branding per customer are not built.
