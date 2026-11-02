# kuyil-web architecture

`src/index.ts` routes `/v1/*` to the `API` binding and everything else to `ASSETS`, adding a strict content security policy to pages. There is no build step for `public/`.

User text only reaches the page through `textContent` (`h()` in `core.js`). Never add `innerHTML`.

The bearer token is kept in `localStorage`, as the console does.
