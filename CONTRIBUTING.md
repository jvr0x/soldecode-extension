# Contributing to SolDecode Extension

Thanks for your interest in contributing. This guide covers how to get set up and what we expect from contributions.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone git@github.com:YOUR_USERNAME/soldecode-extension.git
   cd soldecode-extension
   ```
3. **Install** dependencies:
   ```bash
   npm install
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b feat/your-feature-name
   ```
5. **Build and test**:
   ```bash
   npm run build
   npm test
   ```
6. **Load the extension** in Chrome for manual testing:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `dist/` folder

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format:

```
<type>: <short description>

[optional body]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | A new feature or capability |
| `fix` | A bug fix |
| `docs` | Documentation changes only |
| `refactor` | Code changes that don't fix a bug or add a feature |
| `test` | Adding or updating tests |
| `chore` | Build config, dependencies, CI, tooling |
| `perf` | Performance improvements |

### Examples

```
feat: add Solflare wallet support
fix: handle frozen Wallet Standard feature objects
docs: update README with new configuration options
refactor: extract balance diff logic into separate module
test: add edge case for multi-hop swap simulation
chore: update vitest to v3
```

### Rules

- Use **imperative mood** in the description ("add" not "added", "fix" not "fixes")
- Keep the first line under **72 characters**
- Use the body to explain **why**, not what (the diff shows the what)
- Reference related issues with `Closes #123` or `Fixes #123` in the body

## Pull Request Process

1. **One PR per concern** — don't mix unrelated changes
2. **Write tests** for new logic — especially in `src/lib/` modules
3. **Run the full test suite** before submitting: `npm test`
4. **Build successfully**: `npm run build`
5. **Manual test** on at least one dApp (Jupiter is the standard test target)
6. **Fill out the PR description** — explain what changed and why
7. **Keep PRs small** — large PRs are harder to review and more likely to have issues

### PR Title

Follow the same conventional commit format:

```
feat: add support for Token-2022 approvals
```

### Review

- All PRs require at least one review before merging
- Address review feedback with new commits (don't force-push during review)
- Squash merge into `main` when approved

## Code Guidelines

### General

- **TypeScript** for all source files — no `any` unless absolutely necessary
- **Document exported functions** with JSDoc comments
- **One responsibility per file** — if a file is growing beyond ~200 lines, consider splitting
- **No external runtime dependencies** in the extension — keep the bundle small

### Testing

- **TDD preferred** — write the test first when adding new `src/lib/` modules
- **Mock external APIs** (RPC calls, chrome.storage) in tests
- **Test behavior, not implementation** — tests should survive refactors

### Security

This extension touches users' wallets. Security is not optional.

- **Never log transaction contents** in production — the debug logs must be removed before release
- **Never exfiltrate data** — all simulation happens via the user's own RPC endpoint
- **Validate all inputs** — especially data from `window.postMessage` (any page script can send messages)
- **Use Shadow DOM** for UI to prevent dApp CSS/JS interference
- **Fail open** — if anything goes wrong, let the transaction proceed. Never block the user from using their wallet.

## Project Structure

```
src/
├── inject.ts              # Main world: provider patching
├── content-script.ts      # Isolated world: message bridge + drawer
├── service-worker.ts      # Background: simulation + decoding
├── ui/                    # Shadow DOM drawer component
├── lib/                   # Core logic (decoder, risk, errors)
├── types/                 # TypeScript type definitions
└── messaging/             # Inter-component message protocol
```

When adding new features:
- **New decoders/analyzers** go in `src/lib/`
- **New UI components** go in `src/ui/`
- **Tests** go in `__tests__/lib/` mirroring the `src/lib/` structure

## Reporting Issues

- Use GitHub Issues
- Include: Chrome version, Phantom version, the dApp URL, and what happened vs what you expected
- Console logs (filtered to `[SolDecode]`) are very helpful for debugging

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0 license](LICENSE).
