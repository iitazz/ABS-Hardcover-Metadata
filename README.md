# ABS Hardcover Metadata

A custom metadata provider for [Audiobookshelf](https://www.audiobookshelf.org) that searches [Hardcover](https://hardcover.app).

## Run

```yaml
services:
  abs-hardcover:
    image: ghcr.io/iitazz/abs-hardcover-metadata:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/data"]
    environment:
      PUID: 1000   # `id -u`
      PGID: 1000   # `id -g`
```

The container starts as root only to fix ownership of `/data`, then runs the app as `PUID:PGID` (default 1000:1000). To never start as root, use `user: "1000:1000"` instead of PUID/PGID and make sure `./data` is writable by that user.

1. Open `http://<host>:3000` and create the admin password (first visit only — do this right away, before exposing the port).
2. Enter your Hardcover API token (hardcover.app/account/api) and an Authorization key.
3. In Audiobookshelf: Settings → Item Metadata Utils → Custom Metadata Providers → add `http://<host>:3000` with the same key as the Authorization header value.

The dashboard shows request counts, failures and latency. All state lives in `/data`.
