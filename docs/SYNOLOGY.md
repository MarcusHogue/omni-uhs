# Omni UHS on a Synology NAS

Written for **DSM 7.2** with **Container Manager** (called Docker on DSM 6 and
early 7). Works on any x86-64 Synology; the published images are `linux/amd64`,
so ARM models (DS1xxj, DS220j and friends) need the *Build on the NAS* note in
§6.

There are two ways to run it, and the first is the one you want.

| | How it works | Trade-off |
|---|---|---|
| **A. Native Tailscale + local stack** | Synology's Tailscale package handles the tunnel; the containers just serve on a local port | Recommended. No privileged containers, no `/dev/net/tun` juggling, survives DSM upgrades |
| **B. Tailscale sidecar container** | Exactly the `docker-compose.yml` from the repo | Self-contained, but needs SSH and a privileged container |

> I do not have a Synology to test on, so treat the DSM click-paths as
> written-from-the-docs rather than verified. The container side is identical to
> the local stack, which is fully tested.

---

## 0. Before you start

- **Container Manager** installed (Package Center → Container Manager).
- **SSH** enabled if you want to use the command line: Control Panel →
  Terminal & SNMP → Enable SSH service. Turn it off again afterwards if you
  prefer.
- A shared folder for application data. The convention is `docker`:
  Control Panel → Shared Folder → Create → `docker`.

Create the project folder — over SSH:

```bash
ssh you@your-nas.local
sudo mkdir -p /volume1/docker/omni-uhs/cache
cd /volume1/docker/omni-uhs
```

…or in File Station: open `docker`, create `omni-uhs`, and a `cache` folder
inside it.

> DSM reserves ports 80, 443, 5000 and 5001 for itself. Omni UHS uses **8081**
> below; if something else on your NAS already has it, change both numbers in
> the port mapping.

---

## A. Native Tailscale + local stack (recommended)

### A1. Install Tailscale on the NAS

Package Center → search **Tailscale** → Install → open it and sign in. In the
[admin console](https://login.tailscale.com/admin/machines), confirm the NAS
appears, and enable **MagicDNS** and **HTTPS Certificates** under Settings →
DNS.

### A2. Create the project

Container Manager → **Project** → **Create**:

- **Project name:** `omni-uhs`
- **Path:** `/volume1/docker/omni-uhs`
- **Source:** *Create docker-compose.yml* and paste:

```yaml
services:
  proxy:
    image: ghcr.io/marcushogue/omni-uhs-proxy:latest
    container_name: omni-uhs-proxy
    restart: unless-stopped
    environment:
      PORT: 8080
      HOST: 0.0.0.0
      CACHE_DIR: /data/cache
      # Put a real contact address here: it is sent to every upstream.
      USER_AGENT: "OmniUHS/1.0 (+personal use; you@example.com)"
    volumes:
      - /volume1/docker/omni-uhs/cache:/data/cache
    networks: [omni]
    logging:
      driver: json-file
      options: { max-size: 10m, max-file: "3" }

  web:
    image: ghcr.io/marcushogue/omni-uhs-web:latest
    container_name: omni-uhs-web
    restart: unless-stopped
    environment:
      API_UPSTREAM: proxy:8080
    ports:
      - "8081:80"
    depends_on: [proxy]
    networks: [omni]
    logging:
      driver: json-file
      options: { max-size: 10m, max-file: "3" }

networks:
  omni:
```

Click through to **Done**; Container Manager pulls the images and starts both
containers.

Two things differ from the repo's `docker-compose.local.yml`, both on purpose:

- The cache is a **bind mount** to `/volume1/docker/omni-uhs/cache` rather than
  a named volume, so Hyper Backup and File Station can see it.
- The published port is `8081:80`, not `127.0.0.1:8081:80` — on the NAS the
  tunnel terminates on the host, so the port has to be reachable from it.

Check it: `http://your-nas.local:8081` from a machine on the same LAN.

### A3. Put it on the tailnet

Over SSH:

```bash
# The Synology package keeps its binaries out of PATH.
TS=/var/packages/Tailscale/target/bin/tailscale

sudo $TS serve --bg --https=443 http://127.0.0.1:8081
sudo $TS serve status
```

That publishes the NAS's own `https://<nas-name>.<tailnet>.ts.net` to the
container on 8081, with a real certificate. `--bg` persists across reboots.

Confirm **Funnel is off** (`tailscale funnel status` should say nothing is
being served publicly). Funnel would put this on the open internet, which is
exactly what you do not want.

To undo it later: `sudo $TS serve reset`.

### A4. Firewall

If DSM's firewall is on (Control Panel → Security → Firewall), you do **not**
need to open 8081 to the LAN for the tailnet path — the tunnel connects from
the NAS itself to loopback. Only open it if you also want direct LAN access.

---

## B. Tailscale sidecar container

Use this if you would rather keep everything inside Compose. It needs the
repo's `docker-compose.yml` unchanged, plus two things DSM's GUI cannot
express, so it has to be done over SSH.

```bash
ssh you@your-nas.local
cd /volume1/docker/omni-uhs
sudo curl -fsSLO https://raw.githubusercontent.com/MarcusHogue/omni-uhs/main/docker-compose.yml
sudo mkdir -p ts-config
sudo curl -fsSL -o ts-config/serve.json \
  https://raw.githubusercontent.com/MarcusHogue/omni-uhs/main/ts-config/serve.json

# Auth key and contact address.
sudo tee .env >/dev/null <<'EOF'
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
USER_AGENT=OmniUHS/1.0 (+personal use; you@example.com)
EOF
sudo chmod 600 .env

# The sidecar needs the TUN device. Most DSM 7 kernels have it already:
ls -l /dev/net/tun || sudo insmod /lib/modules/tun.ko

sudo docker compose up -d
sudo docker compose logs -f ts-sidecar
```

The app appears at `https://omni-uhs.<your-tailnet>.ts.net` — a separate tailnet
node from the NAS itself.

Caveats worth knowing before you pick this route:

- The sidecar needs `net_admin`/`sys_module` and `/dev/net/tun`. That is a
  privileged container on your NAS.
- `insmod` does not survive a DSM update; if the stack stops working after one,
  reload the module (Task Scheduler → boot-up task is the usual fix).
- Container Manager's GUI will show the project but cannot edit these settings —
  manage it with `docker compose` over SSH.

---

## 5. Backups

The bind mount in path A makes this easy: point **Hyper Backup** at
`/volume1/docker/omni-uhs`. That covers the upstream cache and, in path B, the
Tailscale state.

Your reading library is not on the NAS at all — it lives in the browser on each
device. Use **Settings → Export library** in the app.

---

## 6. ARM models: build on the NAS

The published images are amd64 only. On an ARM Synology, build them locally:

```bash
ssh you@your-nas.local
cd /volume1/docker
sudo git clone https://github.com/MarcusHogue/omni-uhs.git
cd omni-uhs
sudo docker compose -f docker-compose.local.yml up -d --build
```

Expect the build to take a while on NAS-class hardware, and check you have a
couple of gigabytes free — the Node builder layers are not small. Low-memory
models (under 2 GB) may need swap enabled to get through the Vite build.

---

## 7. Troubleshooting on DSM

**Port 8081 is already taken.** `sudo netstat -tlnp | grep 8081`, then pick
another and change the mapping.

**"permission denied" on the cache folder.** The proxy runs as a non-root user
inside the container. Give the bind mount broad access:
`sudo chmod 777 /volume1/docker/omni-uhs/cache` — it holds nothing sensitive,
only downloaded public files. (The named-volume setups avoid this entirely; it
is the price of a browsable bind mount.)

**Container Manager shows the project as "unhealthy".** Both images have
healthchecks; `sudo docker compose logs proxy` will say why. The usual cause is
the cache path above.

**It works on the LAN but not over Tailscale.** `sudo $TS serve status` on the
NAS, and check MagicDNS + HTTPS Certificates are enabled in the admin console.

**Safari will not offer "Add to Home Screen".** You are on `http://` — iOS only
installs a PWA over trusted HTTPS. Use the `.ts.net` address.
