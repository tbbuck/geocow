# Security

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/tbbuck/geocow/security/advisories/new)**
(the *Security* tab → *Report a vulnerability*). Don't open a public issue.

Include what you found, how to reproduce it, and the impact as you see it.
You'll get an acknowledgement, and a fix or an explanation, as soon as is
practical.

In scope: the `geocow` binary, its HTTP API, the web map, and the Docker
image built from this repository. The share store and `/api/geometry` are
deliberately public-by-design and ephemeral; the shared API key is a doorstop
against abuse, not an access-control system — reports about that design are
welcome, but it isn't itself a vulnerability.
