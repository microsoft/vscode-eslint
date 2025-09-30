## High-Level Overview

This is the server implementation of the ESLint extension

## Design Decisions

### Converting URIs into file system paths

The VS Code API uses URIs to identify resource. ESLint in contrast uses file system paths. The conversion from URIs into file system paths happens in the function `getFileSystemPath` in the `server\src\paths.ts` file