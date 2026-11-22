# Security of current upstream delivery

Runoza uses ready-made PostgreSQL, Open Terminal, Node and RustFS. Own backport patches and
library reassemblies are excluded from the work path, npm overrides and node_modules editing are
removed. [Supply and results](../upstream-delivery.md).

Current npm audit: **0 Critical, 6 High, 6 Moderate** (November 15, 2026, full lockfile).
Production audit (`--omit=dev`): 0 Critical, 6 High, 3 Moderate. High remain in the upstream
Markdown/CSS chain; they are not declared fixed or inapplicable. Details in
[upstream-npm.json](upstream-npm.json). Update compatible releases; in the absence of a fix,
document risk rather than release our own fork.

Audit exceptions apply to the specific image digest and execution profile. Before release,
repeat the exact image scan and separately check the applicability of the findings. Store local
logs and installation inventory in `work/`.

Access control, isolation of work folders, prohibition of internal network assignments,
migration verification and backup/restore remain the responsibilities of Runoza. Updating the
image or execution profile requires a recheck of compatibility.
