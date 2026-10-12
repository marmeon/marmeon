---
'@marmeon/encryption': patch
---

An app now refuses to start with the public test key of the Marmeon repository in `APP_KEY` or `APP_PREVIOUS_KEYS` unless `NODE_ENV` is `development` or `test`.
