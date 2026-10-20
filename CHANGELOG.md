# Changelog

## v0.2.1

[compare changes](https://github.com/AntelopeJS/postgres/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- **external:** Describe and profile the database through interface-database-catalog ([#19](https://github.com/AntelopeJS/postgres/pull/19))
- **external:** Sample a few rows of a relation through the catalog ([#23](https://github.com/AntelopeJS/postgres/pull/23))

### 🤖 CI

- Add a checks job aggregating the node matrix ([#22](https://github.com/AntelopeJS/postgres/pull/22))

### ❤️ Contributors

- Thomas 
- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.0

[compare changes](https://github.com/AntelopeJS/postgres/compare/v0.1.4...v0.2.0)

### 🚀 Enhancements

- ⚠️  Publish as @antelopejs/postgres on public npm ([#21](https://github.com/AntelopeJS/postgres/pull/21))

### 📖 Documentation

- Streamline agent guidance and preserve repository contracts ([#20](https://github.com/AntelopeJS/postgres/pull/20))

#### ⚠️ Breaking Changes

- ⚠️  Publish as @antelopejs/postgres on public npm ([#21](https://github.com/AntelopeJS/postgres/pull/21))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.4

[compare changes](https://github.com/AntelopeJS/postgres/compare/v0.1.3...v0.1.4)

### 🚀 Enhancements

- External mode ([#18](https://github.com/AntelopeJS/postgres/pull/18))

### 📖 Documentation

- Fix the outdated CLI commands in the README ([#16](https://github.com/AntelopeJS/postgres/pull/16))

### ❤️ Contributors

- Thomas ([@Thomasims](http://github.com/Thomasims))
- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.3

[compare changes](https://github.com/AntelopeJS/postgres/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- **indexes:** Add crossInstance indexes and build them concurrently ([#14](https://github.com/AntelopeJS/postgres/pull/14))

### 🩹 Fixes

- **deps:** Align interface packages with the current interface-core line ([#11](https://github.com/AntelopeJS/postgres/pull/11))

### 🏡 Chore

- Remove .git-blame-ignore-revs ([#9](https://github.com/AntelopeJS/postgres/pull/9))

### 🤖 CI

- Use shared private release workflow ([#8](https://github.com/AntelopeJS/postgres/pull/8))
- **release:** Release next from a dedicated branch and restore requireCommits ([#10](https://github.com/AntelopeJS/postgres/pull/10))
- **release:** Reference the shared release workflows through v1 ([#12](https://github.com/AntelopeJS/postgres/pull/12))
- Pin the antelope core locally instead of installing it globally ([#13](https://github.com/AntelopeJS/postgres/pull/13))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.2

[compare changes](https://github.com/AntelopeJS/postgres/compare/v0.1.1...v0.1.2)

### 🩹 Fixes

- **value:** Bind a list of constants as one parameter, not one argument each ([#6](https://github.com/AntelopeJS/postgres/pull/6))
- **types:** An empty shape is not an unknown one, so a merge keeps what it knows ([#7](https://github.com/AntelopeJS/postgres/pull/7))

### ❤️ Contributors

- Fabrice Cst <fabrice@altab.be>

## v0.1.1

### 🚀 Enhancements

- Scaffold PostgreSQL database backend ([25d1a84](https://github.com/AntelopeJS/postgres/commit/25d1a84))
- **query:** Add type and value model ([439ce1e](https://github.com/AntelopeJS/postgres/commit/439ce1e))
- **schema:** Converge DDL and add instance lifecycle ([d4e50e5](https://github.com/AntelopeJS/postgres/commit/d4e50e5))
- **query:** Compile every ValueProxy expression stage ([45a4f57](https://github.com/AntelopeJS/postgres/commit/45a4f57))
- **query:** Build the relation and read pipeline ([de47bbe](https://github.com/AntelopeJS/postgres/commit/de47bbe))
- **query:** Select rows by key and close the write path ([781e98e](https://github.com/AntelopeJS/postgres/commit/781e98e))
- **query:** Join, lookup and a query used as a value ([dd71d8c](https://github.com/AntelopeJS/postgres/commit/dd71d8c))
- **query:** Group and its sub-stream aggregates ([19eb6f4](https://github.com/AntelopeJS/postgres/commit/19eb6f4))
- **query:** Cursors, and the last scaffold error ([0fc7250](https://github.com/AntelopeJS/postgres/commit/0fc7250))
- **changes:** The change log, its triggers and the reaper ([1d44791](https://github.com/AntelopeJS/postgres/commit/1d44791))
- **changes:** The feed registry, its watermark and the three endings ([e9a198d](https://github.com/AntelopeJS/postgres/commit/e9a198d))
- **changes:** The stages, compiled against a logged event ([702268e](https://github.com/AntelopeJS/postgres/commit/702268e))
- Report the conditions the adapter used to pass over in silence ([aaded20](https://github.com/AntelopeJS/postgres/commit/aaded20))
- **database:** Add atomic single-record mutations ([#4](https://github.com/AntelopeJS/postgres/pull/4))

### 🩹 Fixes

- **query:** Harden the type and value model ([3dec954](https://github.com/AntelopeJS/postgres/commit/3dec954))
- **query:** Read a payload's `_id` as an assertion, not an error ([ed82167](https://github.com/AntelopeJS/postgres/commit/ed82167))
- **query:** Read a payload's null `_id` as no key supplied ([252cca5](https://github.com/AntelopeJS/postgres/commit/252cca5))
- **query:** Close the design review's semantic and structural findings ([da1ccfe](https://github.com/AntelopeJS/postgres/commit/da1ccfe))
- **query:** Settle the eight decisions the design review left open ([412b7e5](https://github.com/AntelopeJS/postgres/commit/412b7e5))
- Four defects on paths the conformance suite cannot reach ([3f26c1a](https://github.com/AntelopeJS/postgres/commit/3f26c1a))
- **changes:** Six defects the conformance suite cannot reach ([e92d0a5](https://github.com/AntelopeJS/postgres/commit/e92d0a5))
- Three gaps between the adapter and the document contract ([7b928bb](https://github.com/AntelopeJS/postgres/commit/7b928bb))
- **lookup:** Correlate under a plucked projection, so the other key keeps its index ([#3](https://github.com/AntelopeJS/postgres/pull/3))
- **release:** Publish postgres to the AntelopeJS private registry ([#5](https://github.com/AntelopeJS/postgres/pull/5))

### 💅 Refactors

- Cap private TSDoc at two lines and drop unresolvable citations ([bac0daa](https://github.com/AntelopeJS/postgres/commit/bac0daa))

### 📖 Documentation

- The README as the whole caller-facing contract ([13dd199](https://github.com/AntelopeJS/postgres/commit/13dd199))
- Split the README's reference material into docs/ ([9df0888](https://github.com/AntelopeJS/postgres/commit/9df0888))
- Publish the behaviour, refusals and feed detail that lived in source ([fef09ff](https://github.com/AntelopeJS/postgres/commit/fef09ff))

### 🏡 Chore

- Replace Biome with oxlint, oxfmt and Knip ([#2](https://github.com/AntelopeJS/postgres/pull/2))

### 🤖 CI

- Run on Node 22 and 24, since 20 cannot load the test config ([9ac2fc6](https://github.com/AntelopeJS/postgres/commit/9ac2fc6))
- Standardize npm releases ([f588cd0](https://github.com/AntelopeJS/postgres/commit/f588cd0))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Fabrice Cst <fabrice@altab.be>
- Thomas ([@Thomasims](http://github.com/Thomasims))
- Thomasims <thomas@antelopejs.com>
