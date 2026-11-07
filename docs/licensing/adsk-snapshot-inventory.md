# Reviewed adsk snapshot inventory (not approved for shipping)

Source commit: `07814d19ac63bb3ff0d55e3d35517cf3a71bad8c` in
<https://github.com/AutodeskFusion360/FusionAPIReference>.

All paths below are relative to `Fusion_API_Python_Reference/defs/adsk/`.
Byte lengths and SHA-256 were computed from the raw downloaded blobs on
2026-10-24, without executing upstream Python. All eight have the same
unresolved licensing disposition described in [the review](README.md).

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `__init__.py` | 1243 | `a92d33c5bcfacc817005f5718059066e1b2320ee5f42990db6f74ea73df6cc98` |
| `cam.py` | 402787 | `a560e53ff328639e1c7df1ea83e2e0edb74b149766a8eff03318bb883fc8e492` |
| `core.py` | 951839 | `db6eebdba7f4405262aac84378c42cf6073184f289307c64c36f7b4c61896e30` |
| `drawing.py` | 6014 | `1bcd8048eadd7ab5a594c305b7edbab3c89eb8f89b46726ee976e58d6f460ebd` |
| `electron.py` | 151902 | `22dbb861f8197cf87e8f4f55bc8033f0bfd4840c033b9d9be85052b990979c8e` |
| `fusion.py` | 2800362 | `da6c025ff446b6d5e3cd3b9252788067dff8042a0b231f0b97fdce87cd986030` |
| `sim.py` | 231 | `cbe7a0e7c5e7f6ddd7d24b93d4ced07a2ae50ba3909cc8a99127f237c3faf9df` |
| `volume.py` | 41952 | `6d8150ccf75056e6be2578d05173b6d7ad5678ff37e3f2d2d4b0f694dd042198` |

`sim.py` has imports but no classes/functions: inventory presence is not proof
of complete simulation type coverage. Legal clearance would not establish
technical completeness, checker accuracy or compatibility with every Fusion
version.

Root licensing evidence:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `README.md` | 2631 | `7d1cabd5e0b943bd317205533dfdd3eef19cd47275dfc257d34725bfe56ea141` |
| `LICENSE` | 2309 | `e9ca54e95f2f1d0782c1b2d54d4b3fad8fec890c05b3549f0a74452246d34f34` |

Reproduce using the immutable commit's
[recursive tree](https://api.github.com/repos/AutodeskFusion360/FusionAPIReference/git/trees/07814d19ac63bb3ff0d55e3d35517cf3a71bad8c?recursive=1)
(check `truncated` is false), then download each listed path from
`https://raw.githubusercontent.com/AutodeskFusion360/FusionAPIReference/07814d19ac63bb3ff0d55e3d35517cf3a71bad8c/`
and compute byte length/SHA-256. Never import or execute the downloaded files.
