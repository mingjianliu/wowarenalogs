---
name: wow-arena
description: WoW Arena combat log analysis, benchmark collection, and prompt engineering. Use for analyzing matches, running benchmarks, improving AI prompts, and updating WoW spell/talent data.
---

# WoW Arena

Specialized workflows for the WoW Arena Logs platform, covering combat analysis, performance benchmarking, and AI prompt optimization.

## Core Workflows

### 1. Match Analysis
Analyze a local WoW combat log using AI cooldown analysis. This workflow helps identify key decisions, trade quality, and match-ending sequences.
- **Reference**: [analyze-arena.md](references/analyze-arena.md)

### 2. Benchmark Collection
Collect reference benchmark data from high-rated arena matches to calibrate analysis thresholds (e.g., panic damage thresholds).
- **Reference**: [collect-benchmarks.md](references/collect-benchmarks.md)

### 3. Healer Prompt Optimization
Specialized A/B testing framework for validating whether prompt-builder changes improve healer evaluation scores.
- **References**: [improve-healer-prompts.md](references/improve-healer-prompts.md), [eval-healer-prompts.md](references/eval-healer-prompts.md)

### 4. Data Maintenance
Update static WoW data (spells, talents, archetypes) and refine arena geometry maps.
- **References**: [update-wow-data.md](references/update-wow-data.md), [refine-arena-geometry.md](references/refine-arena-geometry.md)

### 5. Development & Testing
Utilities for checking dependencies, codegen, and testing with raw logs.
- **References**: [test-with-logs.md](references/test-with-logs.md), [check-deps.md](references/check-deps.md), [codegen.md](references/codegen.md)

## Usage Guidelines

- Always refer to the specific reference file for the chosen workflow to ensure the correct environment variables and scripts are used.
- For match analysis, prefer using the `wow-advisor` MCP tool for player lookups if needed.
- Ensure the parser is built (`npm run build:parser`) before running benchmarks or analysis.
