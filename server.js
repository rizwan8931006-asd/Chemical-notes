const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const config = require("./lib/config");
const authRoutes = require("./routes/auth");
const pageRoutes = require("./routes/pages");
const purchaseRoutes = require("./routes/purchase");
const adminRoutes = require("./routes/admin");
const { db } = require("./lib/db");

const app = express();

if (config.trustProxy) app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "font-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
        "upgrade-insecure-requests": null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    hsts: false, // HSTS is sent only by the https-aware middleware below
  })
);
app.use((req, res, next) => {
  res.set("Referrer-Policy", "same-origin");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
});

// Outer CSRF layer: reject state-changing requests that come from another origin.
// Browsers attach an Origin header on cross-site POSTs; same-origin and
// server-to-server calls (payment webhooks) have none or a matching one.
app.use((req, res, next) => {
  const method = req.method;
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return next();
  const raw = req.headers.origin || req.headers.referer;
  if (raw) {
    try {
      const originHost = new URL(raw).host;
      const host = req.get("host");
      if (originHost !== host) {
        return res.status(403).json({ ok: false, message: "Cross-origin request blocked." });
      }
    } catch {
      return next();
    }
  }
  next();
});

// When public traffic is HTTPS (reverse proxy or Cloudflare quick tunnel that
// supplies x-forwarded-proto): bounce plain-HTTP to HTTPS and tell browsers to
// only ever use HTTPS for this host (HSTS). Cookies become Secure in that case.
// We deliberately do NOT trust x-forwarded-for for IP/rate-limit purposes.
if (config.trustProxy || config.forceSecureCookie) {
  app.use((req, res, next) => {
    const xfp = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (config.forceSecureCookie && xfp === "https") {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (config.trustProxy && xfp === "http") {
      const host = req.get("host");
      return res.redirect("https://" + host + req.originalUrl);
    }
    next();
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", index: false }));

app.get("/healthz", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use("/", authRoutes);
app.use("/", pageRoutes);
app.use("/", purchaseRoutes);
app.use("/admin", adminRoutes);

app.use((req, res) => {
  res.status(404).render("error", { title: "Not found", message: "The page you requested does not exist." });
});

app.use((err, req, res, next) => {
  console.error("[error]", err);
  if (res.headersSent) return next(err);
  res.status(500).render("error", { title: "Server error", message: "Something went wrong. Please try again." });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log("Secure Notes running at", config.baseUrl);
  console.log("Device-bound reader, PDF upload, watermarking, mock payments enabled.");
});

// The tunnel (localtunnel/loca.lt) keeps long-lived upstream connections open.
// Node's small defaults close idle sockets too eagerly and cause intermittent
// 502 Bad Gateway from the proxy, so we keep server sockets alive much longer.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000;

process.on("unhandledRejection", (e) => console.error("[unhandled]", e));