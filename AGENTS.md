This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Canonical development source

- The canonical GitHub repository is the private `ponkichi1552/LiFlow` repository: `https://github.com/ponkichi1552/LiFlow`. `origin` points there.
- `jphacks/tkb_2633` is retained for history only. Do not push to, modify, archive, or delete that repository. The local `legacy-jphacks` remote has its push URL disabled.
- `main` is the canonical integrated development source. Reuse the current checkout and branch for the authorized task. Create another branch or worktree only when isolation is actually needed.
- After the authorized change passes its checks, integrate it into `main` and retire the completed branch. Do not leave completed work only on a feature branch while `main` falls behind.
- Preserve uncommitted work and unadopted experiments in a verified, recoverable archive before retiring their refs. A historical checkout is not the current app source. See `docs/development-workflow.md`.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Preserve existing features

- Read `docs/feature-contracts.json` before changing an existing feature. These are acceptance requirements, including waste recurrence/onboarding/calendar labels and unknown-date chore activation.
- Keep the required behavior tests and screen wiring tests. Do not delete or relax a feature contract just to make a failing change pass. Change a contract only when the user's requested behavior changes, and explain it in the change report.
- `npm test` checks that required tests still exist and then executes them. CI independently checks the registry too. Restored or newly added behavior needs a regression test that fails when the behavior is removed.
- Compare the current main with the relevant feature branch before integration. A successful test suite without coverage for a missing feature is not proof that the integration preserved it.
