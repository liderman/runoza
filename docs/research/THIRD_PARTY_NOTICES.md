# Accounting for third-party components of stage 0

Runoza saves Apache-2.0 for proprietary code. Third-party source and binaries retain their licenses. This is based on a local prototype, not a redistributable release declaration.

## JavaScript

Exact versions are given in `package-lock.json`For the current tree, generate a SBOM command. `npm sbom --sbom-format cyclonedx` list of licenses by team `npm run licenses`Archive. `notices/npm-licenses.tar.gz` contains notifications of the original prototype and does not replace notifications corresponding to the release assembly.

MPL-2.0 applies to @bem-react/classname and lightningcss. For local development, they remain valid free components. The MPL has a copyleft file area and allows combination with Apache code; this is confirmed by [Mozilla's official FAQ, questions 8, 11, 13 and 16](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). Before issuing a client bundle, you must enable notification and access to the relevant MPL source, and save changes to MPL files under MPL. The fact of minimization does not remove these obligations. We do not copy MPL code into our own Apache files.

Sources for release preparation: [bem-react](https://github.com/bem/bem-react), [lightningcss](https://github.com/parcel-bundler/lightningcss). The exact match of the source to the versions must be checked when creating the release source bundle. The full source bundle is not the result of the compatibility phase and is not yet published.

## Open Terminal

The license [of the original Open Terminal project](https://github.com/open-webui/open-terminal) is MIT. The version and digest of the image used is determined by Compose. The Python and OS component notifications must be taken from the corresponding image.

In a slim image, there are OS utilities with their own copyleft licenses, such as git and shell. The image cannot be described as entirely MIT or Apache. Separately executing a CLI in a container does not mean relicensing Runoza; distributing this image requires its own notices and source obligations. Local build does not replace a release audit.

## LiteLLM

The test gateway is built from litellm 1.108.5 (MIT). The proxy extra setup pulls up the litellm-enterprise 0.1.79.post1 from the LicenseRef-Proprietary. This packet is removed at the stage build; the final clean runtime only copies the remaining /usr/local so that the proprietary packet does not remain in the layers of the distributed runtime.

LiteLLM is an optional external gateway, separate from the Runóza server code, and its test image is designed for the laboratory.

## Prior to publication

Before releasing binaries, collect notifications and required source codes for exact dependency versions, check for transitive updates, and generate a SBOM for each image.
