# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.4.3...v0.4.4) (2026-08-20)


### Changed

* **deps-dev:** bump @biomejs/biome from 2.5.7 to 2.5.8 ([#50](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/50)) ([60ff1dc](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/60ff1dc82b8dd1c473a431c23e9dd819bd07e987))
* top-level help lists session as claude + pi ([#51](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/51)) ([34399aa](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/34399aa69d6c1a6683564b5dfb5a3d8965972c82))

## [0.4.3](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.4.2...v0.4.3) (2026-08-19)


### Added

* session-mode live question channel - claude + pi ask without exit/resume ([#44](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/44)) ([#47](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/47)) ([ddf09c1](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/ddf09c10754cb7f761630d0acbfc4187f42528de))


### Changed

* fixture pi --mode rpc spike evidence (25/25 assertions) ([#45](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/45)) ([2a5c4de](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/2a5c4de364a492b5b6c1aa59668b6d16b591ba73))

## [0.4.2](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.4.1...v0.4.2) (2026-08-19)


### Added

* question escalation - headless workers ask the caller's user, answers flow back via resume ([#41](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/41)) ([#42](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/42)) ([5a0205a](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/5a0205addc80dfa8d2a0dd0ee6cd978e01abc485))

## [0.4.1](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.4.0...v0.4.1) (2026-08-19)


### Added

* 0.5.0 - round 2 defaults, tools equivalence, skills allowlist ([#39](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/39)) ([06feefe](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/06feefe1363ed6bb7396db396f50fe7835caccac))

## [0.4.0](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.3.1...v0.4.0) (2026-08-19)


### ⚠ BREAKING CHANGES

* 1.0.0 - defaults profile, config tiers, tool selection, CLI-only surface ([#36](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/36))

### Added

* 1.0.0 - defaults profile, config tiers, tool selection, CLI-only surface ([#36](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/36)) ([986ce17](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/986ce1771cc8c538b10b6663f5cd04c9bc434563))

## [0.3.1](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.3.0...v0.3.1) (2026-08-17)


### Fixed

* clean stream-turn cruft and document drift/session scope ([#31](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/31)) ([24c90a3](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/24c90a3e7029ac951ab51be007f715bcd58363f9))
* run the hcn bin entry regardless of symlink name ([#34](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/34)) ([3f6a11c](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/3f6a11c51a1eec96941be8f7f1364ffb1dc26f23))


### Changed

* re-verify descriptors against claude 2.1.233 and pi 0.84.2 ([#35](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/35)) ([795670d](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/795670d7949e5308d8f71da0fa35512fb7253a6b))

## [0.1.3](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.1.2...v0.1.3) (2026-08-13)


### Fixed

* dispatch npm publish after release ([#26](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/26)) ([3c7a987](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/3c7a987cf02b4f8ce94b00e46ddceb8daa226c7c))

## [0.1.2](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.1.1...v0.1.2) (2026-08-13)


### Added

* publish package on npm ([#23](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/23)) ([07380c3](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/07380c36d732059bbd19142b86eb3640f1ae96ae))


### Fixed

* normalize npm repository metadata ([#25](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/25)) ([3008613](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/3008613fa8ff36b266deeb8b7beea3dd4d817dcb))

## [0.1.1](https://github.com/dungle-scrubs/harness-cli-normalizer/compare/v0.1.0...v0.1.1) (2026-08-12)


### Added

* buildLaunchArgv with flag-injection and empty-grant refusals ([1388c51](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/1388c5171c1d23adfb6a355b4d8abaacab959ae2))
* codex, pi, muse descriptors + resumeLast corroboration ranking (M2.3) ([e0e1565](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/e0e15651880644be1f35729d26a5103129aab14c))
* detect silent provider/auth failures ([#3](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/3) detection) ([e8d6a7f](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/e8d6a7fb36fb9dd459cc47d69d629d762829c235))
* encode resume-of-missing behavior + close resume edge cases ([#5](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/5)) ([544d036](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/544d0366187ebd602174f9ebef7fb212d0d7c906))
* exercise all four harnesses through the runner (codex/pi/muse content) ([2303b31](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/2303b31700b529de3c29ca10eb38694f5fa7f193))
* harness-update detector - check:versions + versionSource + CI (issue on new release) ([1c433fb](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/1c433fb8dd63d0e48b88c1284c3c535014508f0f))
* interactive demo CLI - drive any harness and watch events stream live ([43cabb2](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/43cabb294ad867549a4d9668ece1257615f5ef5e))
* move persistent session input into descriptors ([#17](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/17)) ([1b62338](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/1b62338daee7f13c1a56a487c880b8c7bc2a457f))
* non-shell tool decoding ([#2](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/2)) ([bcd995e](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/bcd995e60ca6ce0c104bbb142c39c05c5fa97d76))
* openSession persistent session runner (M3.2) ([f49af75](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/f49af75c59e386d4f3aeb26cdaec7397d7533076))
* override file loading - defaults, validated merge, path-naming refusals (D-006) ([3108807](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/31088073f659727a031b4c939b1d0cfd2c995b3f))
* real runtime adapter, resume turns, real-claude smoke script (M3.3) ([caea9dc](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/caea9dc7cdd1952ae6eb593b79682b414623d105))
* seven-scenario compat smoke + spawn-error surfacing fix (M7.2, runner scope) ([6c1e053](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/6c1e053492cc850ea3f13b102ff5e5572a066965))
* store path, context hook, presence, capability resolution, dimension coverage + purity guards ([554692f](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/554692f34f6aa023e8f2378be7e3429eff19d834))
* streamTurn spawn-per-turn runner (M3.1) ([f6bf7a3](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/f6bf7a39dadf0f736b5a55a782594e9036758f42))
* tool-call decoding for codex, pi, and muse ([74134e2](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/74134e22c6af99fc54125fcd6a23b4abb9257ed1))
* verifiedAgainst version anchor on descriptors (harness-update pipeline) ([032c45a](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/032c45aebccc898c5e23274976f15109624bc13d))


### Fixed

* apply all-harness review findings ([7708408](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/77084080c55b6a9639d8a0d8ad93849d5e6ce0ef))
* apply M2.1 boundary-review findings ([921f162](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/921f162a14fea96b36f762897b252469dd9830b7))
* apply M2.2 boundary-review findings ([62ded3d](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/62ded3de298bdc9ca761220b306790a54c126291))
* apply M2.3 boundary-review findings (verified against live CLIs) ([cf5df2b](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/cf5df2b77691aca3cc393eeb5c84835241eefbbd))
* apply M3.1 boundary-review findings (async hardening) ([a3023bc](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/a3023bcd396bd27156983ab18c0d021dc7b0bcc6))
* apply M3.2 boundary-review findings (session lifecycle hardening) ([8471a85](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/8471a85fd71681b4075a3020e6996eeb64950dee))
* apply phase-2 codex review findings ([69cce15](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/69cce15baa4cfaa91715f3defc3ffce5f6426902))
* apply phase-3 codex review findings ([9c15603](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/9c156036d58d7d97491c319ccfa0c51988923c97))
* apply tools+smoke review findings ([58ef75b](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/58ef75bc6440977c44e8eaf1dda4bbd96e8ddc68))
* close() awaits full session shutdown (pump drained, session_close logged) ([05b96ff](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/05b96ff25c5158a217f61a9e0a0e73c453b47b70))
* don't double-emit claude result is_error in openSession (review) ([9732438](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/9732438202d3c0123c66201a952a7c48fde2e677))
* ENOENT classifies as crash 127 in the real adapter; seam guard test ([bbd7ec4](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/bbd7ec4ac3c993d4008f7125abcc8df7922d59ba))
* kill-and-resume works for all resumable harnesses, not just session-mode ([cf98ddb](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/cf98ddb53f614db3e9134986d607b491ded279fd))
* settle abandoned output pumps ([#18](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/18)) ([1033ec4](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/1033ec419204166b6a5627a0fb01e40f2b3f855d))


### Changed

* 0.1.0 - milestone-1 substrate landed ([87e6ccf](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/87e6ccfcc092e8b69d137dd8b8c5388edc03ce3f))
* apply scaffold review fixes (repo-scoped hooks, scoped test discovery, composed scripts) ([12064d0](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/12064d0f60c071efefe61763d8425bb9c53c843e))
* check main before release ([#19](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/19)) ([b4d8c17](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/b4d8c17d55281fe4aab2c9664a18a81de291afdc))
* complete session backpressure CI plan ([#22](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/22)) ([01a1f57](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/01a1f5752eee56845b4e11cf3764f470c0a02710))
* export execution layer API from index ([c46d210](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/c46d21066bdd5320f50ddc0cc68710a835795077))
* migrate biome config to 2.x preset key ([c12dabe](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/c12dabe242d3923455c995015490e99499cc7816))
* pin bun install off, widen types hook glob (codex review) ([436b14a](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/436b14a5ad943690ac6319432c2f2c7c72d657f8))
* prepare repository for public release ([#12](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/12)) ([a8f9f61](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/a8f9f616018267b8d5eb4f3e6a021a9e7865a4a7))
* root commit ([c42ea33](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/c42ea3324cd58fea436626cf8de545180642ae5f))
* target repository for release PR checks ([#21](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/21)) ([9575456](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/9575456754d28abe7a6e06ab6e7c7e12cac811c6))
* verify descriptor against claude 2.1.227, bump verifiedAgainst ([d1574eb](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/d1574eb4279ed63b0a53730f3ec291b210290e8b))

## [Unreleased]

Release entries below this section are generated by release-please from
conventional commits when a release PR is merged.
