# antelopejs

## Code Conventions

### Critical Rules

| Rule                  | Description                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- |
| English only          | All code must be in English: variable names, function names, comments                   |
| PNPM only             | Always use pnpm, never npm or yarn                                                      |
| NO COMMENTS           | Code must be self-documenting through clear naming. TSDoc is allowed for public APIs    |
| NO switch/case        | Use objects, maps, or arrays instead                                                    |
| NO inline types       | Define proper interfaces/types, never use anonymous types like `{a: string, b: number}` |
| Functions ≤ 40 lines  | Split into subfunctions if longer                                                       |
| NO magic values       | Extract to named constants                                                              |
| Generic over specific | Avoid case-by-case logic                                                                |
| 2 spaces              | Use spaces, not tabs                                                                    |
| Index re-exports      | In index files, prefer `export * from './module'` over named re-exports                 |

### Code Structure

- Prefer generic approaches over ad hoc processing
- Limit functions to 30-40 lines max
- Split into subfunctions for readability
- Reduce indentation with early returns
- Keep files concise and focused
- No code duplication (DRY)
- Separate logic from definitions

### Documentation Placement

DRY applies to prose. A stated fact — a measurement, a constraint, a reason a shape was chosen —
gets one owner, and every other site references it instead of restating it. A number restated in
four places is four places to update and three chances to be wrong, which is the same failure DRY
exists to prevent in code.

- A **private** function gets at most two lines of TSDoc.
- Anything longer goes on the module's **exported map or type**, which is where a reader looking for
  the family's reasoning arrives.
- An **exported** function documents its own contract, since its callers cannot see the module essay.

### Flow Management

Never use `switch/case` or `if param === 'XXX'` chains. Instead:

```typescript
// BAD
function getStatus(code: string) {
  switch (code) {
    case "A":
      return "Active";
    case "I":
      return "Inactive";
    default:
      return "Unknown";
  }
}

// GOOD
const STATUS_MAP: Record<string, string> = {
  A: "Active",
  I: "Inactive",
};

function getStatus(code: string) {
  return STATUS_MAP[code] ?? "Unknown";
}
```

Use array iterations with early returns:

```typescript
// BAD
function findUser(users: User[], id: string) {
  let result = null;
  for (const user of users) {
    if (user.id === id) {
      result = user;
      break;
    }
  }
  return result;
}

// GOOD
function findUser(users: User[], id: string) {
  return users.find((user) => user.id === id) ?? null;
}
```

### Naming

- Names indicate role/content, not type
- Booleans: `isActive`, `shouldRefresh`, `mustValidate`
- Adapt clarity to scope (longer names for broader scope)

### Design Principles

- **DRY**: Don't Repeat Yourself
- **KISS**: Keep It Simple, Stupid
- **SOLID**: Single responsibility, Open/closed, Liskov substitution, Interface segregation, Dependency inversion
