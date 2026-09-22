# SKYHOOK - static serve, no build step.
#
# The whole point of this game is that it is a folder of files a browser can
# open. There is no bundler, no transpile and no runtime dependency, and this
# image keeps that true: it COPIES the folder and puts nginx in front of it.
# Nothing is compiled and nothing is minified, so the bytes served are the
# bytes in the repo - which is what makes "open index.html from file://" and
# "load the deployed site" the same game rather than two builds that drift.
#
# Two stages, so the runtime image does not carry the test suite, the
# screenshots or the git history. There is still no build step: stage one is a
# glorified `cp` whose only job is to name, explicitly, every file the public
# is allowed to fetch. A COPY . . would have shipped test/, docs/ and
# package.json the first time somebody added a file without thinking about it.

# ---------------------------------------------------------------------------
# 1. Collect exactly what the browser is allowed to see.
# ---------------------------------------------------------------------------
FROM alpine:3.20 AS site

WORKDIR /src
COPY index.html screenshot.png ./
COPY css/ ./css/
COPY js/ ./js/
COPY conf/404.html ./404.html

# ---------------------------------------------------------------------------
# 2. Serve it.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine

# conf/site.conf.template uses sub_filter and gzip_static. The official image
# is built with both, but a base-image bump that quietly dropped either would
# otherwise produce a site that looks fine and serves the wrong canonical URL
# or an uncompressed 80 KB of JavaScript. Fail the build instead.
RUN nginx -V 2>&1 | grep -q -- '--with-http_sub_module' \
 && nginx -V 2>&1 | grep -q -- '--with-http_gzip_static_module' \
 || (echo 'FATAL: base nginx lacks sub_filter or gzip_static' && exit 1)

# /etc/nginx/templates/*.template is run through envsubst by the stock
# entrypoint before nginx starts, which is how SITE_ORIGIN reaches the config
# without a build step. Only names that exist in the environment are
# substituted, so nginx's own $uri / $http_* variables survive untouched.
COPY conf/site.conf.template /etc/nginx/templates/default.conf.template
COPY --from=site /src /usr/share/nginx/html

# Pre-compress the static text assets ONCE, at image build time, so nginx
# answers with gzip_static instead of re-gzipping the same never-changing file
# on every request. The uncompressed original stays beside it for clients that
# do not send Accept-Encoding: gzip.
#
# index.html is deliberately EXCLUDED: gzip_static serves a .gz byte-for-byte
# and sub_filter cannot rewrite bytes it cannot read, so pre-compressing the
# one file that needs rewriting would silently disable the SITE_ORIGIN
# rewrite. It is ~7 KB and is gzipped on the fly instead.
RUN find /usr/share/nginx/html \
      \( -name '*.js' -o -name '*.css' -o -name '*.svg' \) \
      -exec gzip -9 -k {} \;

# The ONE knob that carries the public hostname. It MUST match the origin
# literal in index.html, which conf/site.conf.template searches for; equal
# values make the default an identity rewrite - a no-op - rather than a silent
# mangling of the meta tags. fly.toml sets the same value, so production is an
# identity rewrite too and the served page is byte-identical to the repo. An
# override is for serving the game from somewhere that genuinely is not
# skyhookplay.com, e.g. a staging host that should not claim the canonical.
ENV SITE_ORIGIN="https://skyhookplay.com"

# The OTHER knob: which environment this container IS. The page ships
# window.SKYHOOK_ENV = 'production' and conf/site.conf.template rewrites it
# through the same sub_filter mechanism as the origin above. It decides two
# things and nothing else: whether the staging banner is drawn, and whether
# the online layer refuses to write to the leaderboard.
#
# It defaults to "production", which makes the rewrite an identity no-op
# unless fly.staging.toml overrides it. That is the safe direction to fail
# in: a container that has lost this variable behaves as production - it
# submits scores, which is what production is for - rather than silently
# turning the real site read-only and swallowing everybody's runs.
ENV SITE_ENV="production"

# nginx must run in the foreground: on Fly the machine's lifecycle IS the
# process's lifecycle, and a daemonised nginx exits at once and reads as a
# crash loop.
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
