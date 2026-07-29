# `@devin/email`

Transactional email via Resend: magic-link and verification templates used by
Better Auth flows in `@devin/api-v1`.

```ts
import {
  sendMagicLinkEmail,
  sendVerificationEmail,
} from "@devin/email";
```

Requires `RESEND_API_KEY` and a configured from-address (see `src/client.ts`).
