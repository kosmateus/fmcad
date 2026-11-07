# Stage 4d: typed CAD script preparation

CAD preparation now lives in the TypeScript Node adapter. The composition root
supplies catalog validation, inspection planning, curve preparation and import
preflight. The public JavaScript CAD facade delegates preparation and path
mapping to that adapter; dispatch migration remains separate work.

Paired tests use frozen source from `5292078`, before this extraction, and compare
complete artifacts: Python bytes, units, hashes and document context. They cover
document status, inspection, two curve routes, parameter/catalog imports, COTS
replacement and file import/export. The full component profile and the smaller
document profile retain their original selection. All eleven path families,
Windows/UNC paths, caller-input preservation and validation failures are checked.
No expected CAD result changed in this stage.

The existing import test assumed WSL path conversion while running on Linux.
Its COTS example fails with the same `UnsupportedPlatformError` in both the
frozen and current implementations. It now explicitly installs the existing
offline WSL fixture and restores it after the suite. Its assertions are unchanged;
the fixture does not relax production platform detection.

The installed-package test checks both new modules and their declarations, then
prepares a document-status artifact through the packaged public facade. Local
validation passed 70 CAD, curve, import and native-action tests, the complete
build, lint, TypeScript checks and formatting. Full CI, including installation,
remains required before merging. Native Fusion is deferred to final qualification.
