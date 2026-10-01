# BespokeCore test app

The app every framework feature is shown and tested in (`modules/auth`, `modules/user-profile`).

```bash
cp .env.example .env && pnpm exec bespoke key:generate
pnpm exec bespoke migrate:fresh --seed
pnpm dev
```

## Demo users

`migrate:fresh --seed` creates three people. Each signs in with the password **`password`**:

| Name         | E-mail            |
| ------------ | ----------------- |
| Ada Lovelace | ada@example.com   |
| Alan Turing  | alan@example.com  |
| Grace Hopper | grace@example.com |
