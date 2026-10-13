 
# Copilot Instructions for This Repository

## Overview

This repository contains a web-based project implemented using **HTML and JavaScript**.

The project should remain **simple, modular, and easy for contributors to understand**. Code should prioritize:

- Clarity
- Modularity
- Maintainability
- Contributor friendliness

This repository is licensed under the **GNU Affero General Public License (AGPL)**.  
All contributions must remain compatible with this license.

---

# Core Principles

## 1. Keep the Code Modular

Structure the project so that functionality is separated into small reusable modules.

Guidelines:

- Each JavaScript file should have **one clear responsibility**
- Avoid large monolithic scripts
- Prefer **separate modules** rather than embedding everything in a single file
- If the project grows, organize modules into directories

Example structure:

```
/html
/js
/js/modules
/css
/assets
```

When adding new features, prefer **creating new modules** rather than expanding existing files excessively.

---

## 2. Maintain Readability

Future contributors should be able to understand the code quickly.

Rules:

- Use clear variable names
- Use descriptive function names
- Avoid unnecessary complexity
- Prefer straightforward logic over clever shortcuts

Example:

Bad:

```javascript
let x = d()
```

Good:

```javascript
let userData = fetchUserData()
```

---

## 3. Use Helpful Comments

Add comments to help contributors understand how the code works.

Comments should explain:

- The purpose of modules
- Non-obvious logic
- Important assumptions
- How components interact

Example:

```javascript
// Initializes UI event handlers for the main page.
// This should only be called once during page load.
function initializeUI() {

}
```

Avoid redundant comments that simply restate the code.

Bad:

```javascript
// add 1 to count
count = count + 1
```

---

## 4. Keep HTML Clean and Organized

HTML should remain simple and readable.

Guidelines:

- Use semantic HTML elements when possible
- Avoid inline JavaScript
- Avoid large inline styles
- Link JavaScript through external files

Example:

```html
<script src="/js/main.js"></script>
```

---

## 5. JavaScript Guidelines

Prefer modern JavaScript patterns where possible.

Guidelines:

- Use ES modules when possible
- Keep functions small and focused
- Avoid global variables
- Prefer `const` and `let` instead of `var`

Example:

```javascript
export function initializeApp() {

}
```

---

## 6. Preserve Simplicity

This project intentionally avoids unnecessary frameworks.

Do NOT introduce:

- Large frontend frameworks
- Unnecessary build systems
- Complex dependency chains

Unless there is a clear and justified need.

---

## 7. Adding New Features

When implementing new functionality:

1. Identify the correct module location
2. Add a new module if needed
3. Ensure code is reusable
4. Add comments explaining the feature

Avoid tightly coupling features together.

---

## 8. Documentation

If you introduce new modules or functionality:

- Add comments explaining how it works
- Update the README if needed
- Ensure the code is understandable without deep context

---

## 9. Licensing

This repository uses the **GNU Affero General Public License (AGPL)**.

All contributions must:

- Remain compatible with AGPL
- Retain license headers where applicable
- Avoid introducing dependencies with incompatible licenses

Recommended license header for JavaScript files:

```javascript
/*
Project Name
Copyright (C) 2026

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License.
*/
```

---

## 10. Contributor Mindset

Assume future contributors may:

- Be new to the project
- Be learning the codebase
- Need guidance from the code itself

Write code that **helps the reader understand the system**.

Favor **clarity over cleverness**.