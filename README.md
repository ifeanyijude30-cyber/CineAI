# CineAI — Commercial MVP + Admin Dashboard

This package adds a secure admin dashboard to the CineAI commercial MVP.

## Admin features

- User count
- Generation count
- Successful/failed generations
- Revenue total from recorded successful payments
- User list with credit balances
- Server-side credit adjustment
- Generation activity
- Payment history
- Admin access controlled by `ADMIN_EMAILS`

## Run

1. Copy `.env.example` to `.env`.
2. Configure Supabase, fal.ai and Paystack keys.
3. Set `ADMIN_EMAILS` to the email(s) that should have admin access.
4. Run the SQL in `supabase_schema.sql`.
5. Run:
   npm install
   npm start
6. Main app: `/`
7. Admin dashboard: `/admin.html`

The dashboard never receives the Supabase service-role key. Admin queries are performed by the backend after verifying the signed-in user's email against `ADMIN_EMAILS`.

## Before public launch

Add:
- proper role table instead of email allow-list
- audit logs
- pagination/search
- persistent job queue
- object storage/CDN
- moderation
- rate limits
- customer support/refund tools
- legal pages and consent
- monitoring and backups
