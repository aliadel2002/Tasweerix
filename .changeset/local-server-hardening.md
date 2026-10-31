---
"@tasweerix/cli": minor
"@tasweerix/media": minor
---

Security hardening of the local servers. The studio and the render server now require a random per-session access token: the studio prints a link that carries it and turns it into an HttpOnly, SameSite=Strict cookie. Both servers refuse requests from other origins and from foreign `Host` headers, which blocks CSRF and DNS rebinding, so a web page can no longer read project files, upload code or start exports. Studio file, entry, upload, export and command paths must stay inside the project, symlinks included (new `resolveProjectPath`), and failed reads now answer with an error instead of hanging. `serveStatic` validates `Range` headers. The render browser no longer runs with `--disable-web-security`, and studio asset snippets quote file names safely. `startStudio` now returns `link` and `token`; `RenderServer` has `pageUrl`.
