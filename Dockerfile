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
COPY index.html screenshot.png privacy.html ./
COPY css/ ./css/
COPY js/ ./js/
COPY conf/404.html ./404.html

# --------------------------------------------------------------- the overlay
# The ONLY difference between the production image and the staging image, and
# it is a build argument rather than a runtime environment variable on
# purpose. A runtime flag is a flag production can be started with by mistake;
# a build that did not pass --build-arg SKYHOOK_ENV=staging has no staging
# bytes in it at all, so "is this production?" is answered by the image's
# contents instead of by whoever wrote the machine's env.
#
# What the overlay swaps:
#   js/config.js   -> staging/config.staging.js. A DIFFERENT Supabase project
#                     from production's, carrying the same schema from
#                     supabase/schema.sql but none of its data. Also injects
#                     the noindex meta and the orange STAGING banner. The long
#                     version, including why readOnlyScores is now false, lives
#                     in that file.
#   robots.txt     -> Disallow: /. Production still serves no robots.txt; this
#                     line cannot change that, because it does not run.
#
# The `*)` arm is the important one. Without it a typo - SKYHOOK_ENV=stagging -
# would fall through silently and produce a PRODUCTION image under a staging
# app name: the staging site would come up pointed at the real leaderboard
# with write access and look completely normal. deploy.yml builds with a
# deliberately misspelled value and fails if that build succeeds.
#
# `set -e` is explicit rather than assumed, so a renamed or deleted staging/
# file reads as a broken build rather than as a half-applied overlay.
ARG SKYHOOK_ENV=production
COPY staging/ /staging/
RUN set -e; \
    case "$SKYHOOK_ENV" in \
      staging) \
        cp /staging/config.staging.js js/config.js; \
        cp /staging/robots.txt robots.txt; \
        echo "overlay applied: staging" ;; \
      production) \
        echo "overlay skipped: production" ;; \
      *) \
        echo "FATAL: SKYHOOK_ENV must be 'production' or 'staging', got '$SKYHOOK_ENV'" >&2; \
        exit 1 ;; \
    esac; \
    rm -rf /staging

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

# Crawler policy, as a response header. conf/site.conf.template emits
# `X-Robots-Tag: ${ROBOTS_TAG}` and envsubst needs the name to EXIST in the
# environment or the literal survives into the config and nginx refuses to
# start - so this default is load-bearing, not decorative.
#
# "all" is the documented no-op: index and follow, which is exactly what a
# response with no X-Robots-Tag at all already means. Production's behaviour
# is therefore unchanged; it just now says out loud what it was silent about.
# fly.staging.toml overrides this with "noindex, nofollow".
ENV ROBOTS_TAG="all"

# nginx must run in the foreground: on Fly the machine's lifecycle IS the
# process's lifecycle, and a daemonised nginx exits at once and reads as a
# crash loop.
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
