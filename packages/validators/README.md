# `@devin/validators`

Zod schemas shared by the API and web app for request validation.

## Schemas

| Export | Purpose |
| ------ | ------- |
| `authSchema` | Signup / login (name, email, password rules) |
| `dashboardSettingsSchema` | Dashboard settings PATCH body |
| `githubPermissionsSchema` | GitHub permission flags |
| `createTaskSchema` | Task creation payload (prompt, agent, runtime, repo) |

```ts
import { createTaskSchema } from "@devin/validators";

const parsed = createTaskSchema.safeParse(req.body);
```
