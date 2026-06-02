# Dynamic Archetyping Comparison Engine

## Objective
Transition the AI coaching platform from static, JSON-based "Playstyle Summaries" to a live, comparative "Pro-vs-Player" feedback system. By embedding matches as high-dimensional vectors and utilizing Firestore Vector Search, the AI will evaluate users against the top 1% of competitive matches using identical playstyles and talent clusters.

## 1. Architecture & Data Flow
The system utilizes a 3-layer architecture:

1. **Ingestion & Extraction Worker:** 
   - Parses raw combat logs.
   - Executes the external Python script (`/Users/mingjianliu/code/wow-talent-gear-collector/scripts/get_spec_clusters.py`) to determine the talent cluster medoid.
   - Extracts all 3-spell chain sequences and calculates global performance metrics.

2. **Vectorization Utility:**
   - Concatenates the extracted data into a single, L2-normalized feature vector using a "Bag of Patterns" approach to represent the "Global Arc" of the match.

3. **Firestore Indexing & Retrieval:**
   - Stores the 1,282 previously collected "Gold Standard" matches in a new Firestore collection (`reference_matches`).
   - Uses Firestore's native `findNearest` capability (COSINE distance) to retrieve the 5 nearest neighbor matches for any uploaded user match.

## 2. Vector Schema & Features
The "Bag of Patterns" vector represents a match across three core domains:

1. **Talent Fingerprint (Categorical):** 
   - A binary bitmask of influential talent nodes based on the player's talent string. 
   - Ensures the vector search heavily biases towards players using the same build.

2. **Behavioral Patterns (Rotational):** 
   - TF-IDF (Term Frequency-Inverse Document Frequency) weighting of 3-spell rotational chains.
   - We will build a vocabulary of the top 200 most common sequences per spec from the corpus. This captures the rhythm and priority of the player's button presses.

3. **Performance Scalars (Global Arc):** 
   - **Offensive Index:** Ratio of Total Damage Events to Total Healing Events.
   - **CC Density:** Successful Crowd Control applications per minute.
   - **Reaction Latency:** Average delay (in seconds) between a crisis event (teammate < 40% HP) and the deployment of a major cooldown.

*Note: All domains must be L2-normalized to ensure balanced weighting during the nearest-neighbor search.*

## 3. The Comparative AI Sub-Agent
After Firestore retrieves the 5 "Nearest Neighbors," a specialized Sub-Agent executes a Differential Analysis.

**Inputs:**
- The User's Extracted Match Data.
- The Aggregated Data of the 5 "Gold Standard" Matches.

**Analysis & Output Focus:**
- **Gap Analysis:** The AI highlights deviations in the performance scalars (e.g., "Your Offensive Index is 0.15 vs the Pro average of 0.35").
- **Crisis Response Auditing:** The AI compares specific decision trees during low-HP windows (e.g., "At 1:12, you used Pain Suppression. In 80% of similar situations, the pros used Ultimate Penitence instead").
- The output is formatted as a decision-centric comparison report rather than a generic summary.
