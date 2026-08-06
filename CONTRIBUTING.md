# Contributing to Signal Decoder

Thank you for your interest in contributing to Signal Decoder! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Testing Requirements](#testing-requirements)
- [Code Quality](#code-quality)
- [Submitting Changes](#submitting-changes)
- [Adding a New Decoder Mode](#adding-a-new-decoder-mode)

## Getting Started

### Fork the Repository

1. Fork the repository on GitHub
2. Clone your fork locally:

```bash
git clone https://github.com/YOUR_USERNAME/Signal-Decoder.git
cd Signal-Decoder
```

3. Add the upstream repository as a remote:

```bash
git remote add upstream https://github.com/acesso/Signal-Decoder.git
```

4. Install dependencies:

```bash
npm install
```

Node's version is pinned in `.nvmrc` — run `nvm use` (installing it first with `nvm install` if needed) before running any `npm`/`node` command, so you build against the same runtime CI does.

### Create a Branch

Always create a new branch for your work. Use descriptive branch names that indicate the purpose of your changes:

```bash
# For new features
git checkout -b feature/rtty-encoder

# For bug fixes
git checkout -b fix/ft8-window-boundary

# For documentation
git checkout -b docs/improve-cw-decoder-notes

# For tests
git checkout -b test/add-mfsk-varicode-tests
```

Keep your branch up to date with the main branch:

```bash
git fetch upstream
git rebase upstream/main
```

## Development Workflow

### 1. Make Your Changes

- Write clean, readable code following the existing code style
- Use TypeScript for type safety
- Add comments only where the *why* isn't obvious from the code itself (a non-obvious constraint, a workaround for a specific bug, a subtle invariant) — not to restate what the code does
- Follow the existing project structure: each decoder mode lives under `src/lib/<mode>/` (DSP/protocol logic) with a matching `src/components/<Mode>Decoder.tsx` (UI)

### 2. Run Tests Locally

Before committing, ensure all tests pass:

```bash
# Run all tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Check test coverage
npm run test:coverage
```

**All tests must pass before submitting a pull request.**

### 3. Check Code Quality

```bash
# TypeScript type checking + production build
npm run build
```

This project does not currently run a separate linter (no ESLint config) — `npm run build`'s type-check is the enforced quality gate. Fix any type errors before committing.

## Testing Requirements

### Writing Tests

All new code should include appropriate tests. The project uses Jest for testing.

#### Test Coverage Requirements

- **Minimum coverage**: 70% for statements, branches, functions, and lines
- **Core algorithms**: Aim for 90%+ coverage
- **DSP components**: Should have comprehensive test coverage

#### Test File Organization

Tests live alongside each mode's implementation, in `src/lib/<mode>/__tests__/`:

- `src/lib/sstv/__tests__/` — SSTV line decoders, DSP, constants
- `src/lib/ft/__tests__/` — FT8/FT4 parser, gate logic, resampling
- `src/lib/rtty/__tests__/` — RTTY/encoder
- `src/lib/mfsk/__tests__/` — MFSK/NAVTEX decoders
- `src/lib/cat/__tests__/` — CAT radio-control protocol
- `src/lib/audio/__tests__/` — shared audio utilities

Conventions:

- `{component}.test.ts` — tests for the corresponding component
- Use descriptive test names with `describe` and `test` blocks
- Group related tests using nested `describe` blocks

#### Example Test Structure

```typescript
import { YourComponent } from '../your-component';

describe('YourComponent', () => {
  describe('Initialization', () => {
    test('creates instance with valid parameters', () => {
      const component = new YourComponent(sampleRate);
      expect(component).toBeDefined();
    });
  });

  describe('Core Functionality', () => {
    test('processes input correctly', () => {
      const component = new YourComponent(sampleRate);
      const result = component.process(input);
      expect(result).toEqual(expectedOutput);
    });
  });

  describe('Edge Cases', () => {
    test('handles empty input gracefully', () => {
      const component = new YourComponent(sampleRate);
      const result = component.process(emptyInput);
      expect(result).toBeNull();
    });
  });
});
```

### Decode Round-Trips Are the Strongest Test

Where a mode has both an encoder and a decoder (RTTY, FT8/FT4 via the vendored
libs, SSTV), the most valuable test is an encode → decode round-trip: generate
a known message as audio, run it back through the decoder, and assert the
output matches. See `src/lib/rtty/__tests__/encoder.test.ts` for the pattern.
This catches framing/timing bugs that unit tests on either side alone would miss.

### Adding Tests for a New SSTV Mode

When implementing a new SSTV mode decoder, you **must** create a corresponding test file.

#### Line Decoder Test Template

Create `src/lib/sstv/__tests__/{mode}-line-decoder.test.ts`:

```typescript
import { YourModeLineDecoder } from '../your-mode-line-decoder';

describe('YourModeLineDecoder', () => {
  const sampleRate = 48000;

  describe('Initialization', () => {
    test('creates instance with valid sample rate', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      expect(decoder).toBeDefined();
      expect(decoder).toBeInstanceOf(YourModeLineDecoder);
    });

    test('handles different sample rates', () => {
      expect(() => new YourModeLineDecoder(44100)).not.toThrow();
      expect(() => new YourModeLineDecoder(48000)).not.toThrow();
    });
  });

  describe('Scan Line Decoding', () => {
    test('returns null for insufficient buffer', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      const shortBuffer = new Float32Array(100);

      const result = decoder.decodeScanLine(shortBuffer, 0, 0);
      expect(result).toBeNull();
    });

    test('processes valid scan line buffer', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      const buffer = new Float32Array(expectedBufferSize);
      buffer.fill(0); // Neutral gray

      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).not.toBeNull();

      if (result !== null) {
        expect(result.pixels).toBeDefined();
        expect(result.width).toBe(expectedWidth);
        expect(result.height).toBe(expectedHeight);
      }
    });
  });

  describe('Decoded Line Structure', () => {
    test('returns RGBA pixel data', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      const buffer = new Float32Array(expectedBufferSize);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).not.toBeNull();

      if (result !== null) {
        expect(result.pixels).toBeInstanceOf(Uint8ClampedArray);
        expect(result.pixels.length % 4).toBe(0);
      }
    });

    test('pixel values are in valid range', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      const buffer = new Float32Array(expectedBufferSize);
      buffer.fill(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).not.toBeNull();

      if (result !== null) {
        for (let i = 0; i < result.pixels.length; i++) {
          expect(result.pixels[i]).toBeGreaterThanOrEqual(0);
          expect(result.pixels[i]).toBeLessThanOrEqual(255);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    test('handles empty buffer gracefully', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      const buffer = new Float32Array(0);

      const result = decoder.decodeScanLine(buffer, 0, 0);
      expect(result).toBeNull();
    });

    test('handles extreme values', () => {
      const decoder = new YourModeLineDecoder(sampleRate);
      const buffer = new Float32Array(expectedBufferSize);
      buffer.fill(100); // Extreme positive

      expect(() => {
        decoder.decodeScanLine(buffer, 0, 0);
      }).not.toThrow();
    });
  });
});
```

#### Required Test Cases for Line Decoders

1. **Initialization**
   - Valid instantiation
   - Multiple sample rates (44.1kHz, 48kHz, 96kHz)

2. **Scan Line Decoding**
   - Insufficient buffer handling
   - Valid buffer processing
   - Frequency offset handling

3. **Output Structure**
   - Correct resolution (width × height)
   - RGBA pixel format
   - Valid pixel value range (0-255)

4. **Edge Cases**
   - Empty buffers
   - Extreme input values
   - Boundary conditions

5. **Sample Rate Scaling**
   - Timing scales correctly with sample rate
   - Output resolution remains consistent

### Checking Coverage

After adding tests, check that coverage meets requirements:

```bash
npm run test:coverage
```

The output shows coverage for each file:

```text
File                      | % Stmts | % Branch | % Funcs | % Lines |
--------------------------|---------|----------|---------|---------|
your-component.ts         |   95.5  |   87.5   |   100   |   96.2  |
```

Aim for:

- **Core algorithms**: 90%+ coverage
- **Line decoders**: 95%+ coverage
- **DSP components**: 90%+ coverage
- **Utility functions**: 100% coverage

## Code Quality

### TypeScript Guidelines

- Enable strict type checking
- Avoid `any` types - use proper types or `unknown`
- Use interfaces for public APIs
- Document complex types with JSDoc comments

### Code Style

- Use 2 spaces for indentation
- Use single quotes for strings
- Use meaningful variable and function names
- Keep functions small and focused (single responsibility)
- Default to no comments; add one only when the *why* is genuinely non-obvious

### Comments and Documentation

- Add JSDoc comments for public functions and classes where the contract isn't obvious from the signature
- Document complex algorithms with explanatory comments — reference the protocol spec or original implementation when porting code
- Update relevant `.md` files in the `doc/` directory

### Type Checking

```bash
npx tsc -b --noEmit
```

## Submitting Changes

### Before Creating a Pull Request

Checklist:

- [ ] All tests pass (`npm test`)
- [ ] Test coverage meets requirements (`npm run test:coverage`)
- [ ] TypeScript compiles without errors (`npm run build`)
- [ ] Code follows project style guidelines
- [ ] New features include tests
- [ ] Documentation is updated (README, doc/ files)
- [ ] Commits are clean and descriptive

### Commit Messages

Write clear, descriptive commit messages:

```bash
# Good commit messages
git commit -m "feat: add RTTY text-to-FSK encoder with live TX mode"
git commit -m "fix: correct FT8 window rollover timing near UTC boundary"
git commit -m "test: add round-trip tests for the RTTY encoder"
git commit -m "docs: update CONTRIBUTING with current test layout"

# Less helpful commit messages (avoid these)
git commit -m "updates"
git commit -m "fix bug"
git commit -m "wip"
```

Use conventional commit prefixes:

- `feat:` - New features
- `fix:` - Bug fixes
- `test:` - Adding or updating tests
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `chore:` - Build process or tooling changes

### Push Your Changes

```bash
# Push to your fork
git push origin your-branch-name
```

### Create a Pull Request

1. Go to the original repository on GitHub
2. Click "New Pull Request"
3. Select your fork and branch
4. Write a comprehensive PR title and description

#### PR Title Format

Use a clear, descriptive title:

```text
feat: Add RTTY text-to-FSK encoder with live TX mode
fix: Correct FT8 window rollover timing near UTC boundary
test: Add round-trip tests for the RTTY encoder
docs: Improve DSP algorithm documentation
```

#### PR Description Template

```markdown
## Description

Brief description of what this PR does and why.

## Changes

- List of specific changes made
- Any new files added
- Any files modified or deleted

## Testing

- [ ] All existing tests pass
- [ ] New tests added for new functionality
- [ ] Test coverage: X% (meets 70% minimum)
- [ ] Manual testing performed

## Related Issues

Fixes #123 (if applicable)
Relates to #456 (if applicable)

## Screenshots/Output

(If applicable, include screenshots or example outputs)

## Checklist

- [ ] Code follows project style guidelines
- [ ] Tests pass locally
- [ ] TypeScript compiles without errors
- [ ] Documentation updated
- [ ] Commit messages are clear and descriptive
```

### Code Review Process

- Maintainers will review your PR
- Address any requested changes
- Update your PR by pushing new commits to your branch
- Once approved, your PR will be merged

## Adding a New Decoder Mode

Signal Decoder currently supports RTTY, CW, SSTV, FT8/FT4, and MFSK. Adding a
new mode (or a new sub-mode of an existing one, like an SSTV variant or an
MFSK preset) follows the same general shape regardless of which family it
belongs to:

### 1. Research the Mode

- Find official specifications (protocol RFCs, WSJT-X docs, fldigi source, etc.)
- Understand timing, bandwidth, and encoding
- Check reference implementations
- Note characteristic SNR/robustness behavior and typical use cases

### 2. Add Mode Constants

Add the mode's timing/encoding constants to the relevant `constants.ts` (SSTV)
or the mode's own module (RTTY/CW/FT/MFSK don't centralize constants the same
way — follow the existing pattern in that mode's directory).

### 3. Implement the Decoder

Create the decoder under `src/lib/<mode>/`:

- Implement timing calculations
- Implement the mode's specific demodulation/decoding
- Handle sample rate scaling (this app auto-detects 44.1kHz or 48kHz mic input)
- Add debug logging if it'll help diagnose sync/decode issues later

### 4. Create Comprehensive Tests

Create `src/lib/<mode>/__tests__/your-mode.test.ts`:

- Follow the test template above
- Aim for 90%+ coverage on the core algorithm
- Test all edge cases
- If there's a matching encoder, add a round-trip test (see [Decode Round-Trips](#decode-round-trips-are-the-strongest-test))

### 5. Wire Up the UI

- Add or extend the mode's `src/components/<Mode>Decoder.tsx`
- Register the mode in `src/App.tsx`'s mode list if it's a new top-level mode

### 6. Update Documentation

- Add the mode to README.md's Features/supported-modes sections
- For SSTV modes specifically: create `doc/YOUR_MODE.md` and update `doc/MODE_COMPARISON.md`
- Add usage instructions where relevant

### 7. Verify Everything

```bash
npm test                  # All tests pass
npm run test:coverage     # Coverage ≥ 70%
npm run build             # Type-checks and builds successfully
```

## Questions?

If you have questions or need help:

- Open an issue for discussion
- Check existing issues and PRs for similar work
- Review the documentation in the `doc/` directory
- Look at existing decoder implementations as examples

## License

By contributing to this project, you agree that your contributions will be licensed under the same 0BSD license as the project.

Thank you for contributing to Signal Decoder! 🎉
