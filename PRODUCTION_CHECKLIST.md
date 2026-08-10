# CineAI production launch checklist

- Create Supabase project and run `supabase_schema.sql`.
- Create fal.ai API key.
- Create Paystack account and configure the webhook at `/api/paystack/webhook`.
- Put all secret keys in the hosting provider's environment variables.
- Configure HTTPS and a custom domain.
- Replace the in-memory `jobs` Map with Redis/queue + database status before high-volume launch.
- Add durable object storage/CDN for generated videos.
- Add moderation, rate limits, abuse controls, audit logs and monitoring.
- Add final Privacy Policy, Terms, Refund Policy and AI-content consent notices.
- Test Paystack webhook retries and idempotency.
- Never put FAL, Paystack secret, or Supabase service-role keys in browser/Android code.

## Android

1. Install Node.js 20+ and Android Studio.
2. `npm install`
3. `npm run android:add`
4. `npm run android:sync`
5. `npm run android:open`
6. Build a signed Android App Bundle (`.aab`) in Android Studio for Google Play.

The Android project is generated locally by Capacitor so the archive stays lightweight.
