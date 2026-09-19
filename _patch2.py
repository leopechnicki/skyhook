import io

p = '.github/workflows/deploy.yml'
s = io.open(p, encoding='utf-8').read()

# The two broken one-liners, reproduced byte-for-byte from the file.
bad_origin = (
    '          value=$(sed -n "s/^[[:space:]]*SITE_ORIGIN[[:space:]]*=[[:space:]]*'
    "['\"]\\([^'\"]*['\"]\\).*/\\1/p\" fly.toml | head -1)\n"
)
bad_app = (
    '          name=$(sed -n "s/^[[:space:]]*app[[:space:]]*=[[:space:]]*'
    "['\"]\\([^'\"]*['\"]\\).*/\\1/p\" fly.toml | head -1)\n"
)

# A TOML value may be single- or double-quoted and may carry a trailing
# comment. Matching quotes inside a sed program that itself has to be quoted
# for the shell is how you get an unreadable line that is wrong in a way
# nobody spots. Strip instead of match: take everything after the `=`, delete
# both quote characters by OCTAL code (\042 = ", \047 = ') so no quote ever
# appears in this file, then cut at the first space, which removes any
# trailing comment. No hostname is written down either way.
good_origin = (
    '          raw=$(sed -n "s/^[[:space:]]*SITE_ORIGIN[[:space:]]*=[[:space:]]*//p" fly.toml | head -1)\n'
    "          value=$(printf '%s' \"$raw\" | tr -d '\\042\\047' | sed 's/[[:space:]].*$//')\n"
)
good_app = (
    '          raw=$(sed -n "s/^[[:space:]]*app[[:space:]]*=[[:space:]]*//p" fly.toml | head -1)\n'
    "          name=$(printf '%s' \"$raw\" | tr -d '\\042\\047' | sed 's/[[:space:]].*$//')\n"
)

assert bad_origin in s, 'origin one-liner not found'
assert bad_app in s, 'app one-liner not found'
s = s.replace(bad_origin, good_origin).replace(bad_app, good_app)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('both parse steps rewritten')
