# ChoreCade User Guide

**Welcome to ChoreCade – where games do your real digital chores!**

This guide will help you navigate the website and understand how every feature works.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Understanding the Interface](#understanding-the-interface)
3. [The Game Cabinets](#the-game-cabinets)
4. [How Each Game Works](#how-each-game-works)
5. [Calm Mode](#calm-mode)
6. [Google Integration](#google-integration)
7. [The Ledger & Undo](#the-ledger--undo)
8. [Safety Features](#safety-features)
9. [Keyboard Shortcuts](#keyboard-shortcuts)
10. [Accessibility](#accessibility)

---

## Getting Started

### What is ChoreCade?

ChoreCade is an arcade where every move you make does a real chore in the background:
- Shoot down an invader → 400 emails from one sender are archived
- Run a crate to the Images door → 46 screenshots move into your Images folder
- Choose FILE when a monster attacks → A year of coffee purchases is filed under Food
- Beam a crawler in the castle → ESLint fixes lint errors across your project

### Running ChoreCade

```bash
npm run demo        # Builds a sandbox and opens the arcade on http://localhost:4747
```

The demo mode creates a safe sandbox with fake data so you can try everything without touching your real files.

---

## Understanding the Interface

### The Masthead (Top Bar)

![Masthead Section]

The masthead contains:

- **CHORECADE Logo** - Click to return to the main page
- **Mode Indicator** - Shows current mode:
  - `Demo sandbox` - Safe demo with fake data
  - `Live` - Working with your real files/data
  - `Dry run` - Shows what would happen without making changes
- **Google Sign-in** - Connect your Gmail and Drive (see [Google Integration](#google-integration))
- **Worker Status** - Shows background job status:
  - `Worker idle` - No jobs running
  - `Worker: N changes running` - Background work in progress

### Main Area - Today's Backlog

This section shows all available chore cabinets:

- **Title** - Name of the chore (e.g., "Inbox Invaders")
- **Description** - What the game does
- **Count** - How many items remain (e.g., "5,000 emails left")
- **Progress Bar** - Shows completion percentage
- **Impact Summary** - What you've accomplished so far
- **Source Path** - Where the data is coming from
- **Play Button** - Start the game mode
- **Calm Mode Button** - Start the accessible, keyboard-friendly mode
- **Export Button** (for expenses) - Export to Google Sheets

### The Ledger (Right Sidebar)

The ledger shows every real change that has happened:

- **What happened** - Description of the action
- **Chore name** - Which game performed it
- **Timestamp** - When it occurred
- **Undo Button** - Revert the change (see [The Ledger & Undo](#the-ledger--undo))

---

## The Game Cabinets

ChoreCade has four main game cabinets, each handling a different type of chore:

| Cabinet | Chore | Game Type |
|---------|-------|-----------|
| **Inbox Invaders** | Email triage | Space shooter |
| **Folder Frenzy** | File sorting | Arena courier game |
| **Receipt Rush** | Expense review | Turn-based RPG (Undertale-style) |
| **Lint Dungeon** | Fix lint errors | Side-scrolling castle crawl (Metroidvania) |

---

## How Each Game Works

### Inbox Invaders 🚀

**What it does:** Triages your inbox by grouping emails by sender.

**How to play:**
1. Each ship represents one email sender
2. Ship size = how many emails they sent
3. **Weapons & Actions:**
   - **Archive Laser** - Archives all emails from that sender
   - **Trash Torpedo** - Moves emails to trash (takes 2 hits for people)
   - **Unsubscribe EMP** - Unsubscribes from mailing lists (one-click only)
   - **Keep Beam** - Marks emails to keep (gold ships with shields)
4. **Smart Bomb** - Applies your choice to all low-risk ships on screen
5. Ring around ship = suggested action

**Real impact:** One shot can archive hundreds of emails at once!

---

### Folder Frenzy 📦

**What it does:** Sorts messy folders by grouping look-alike files.

**How to play:**
1. You control a robot courier
2. **Crates** contain groups of similar files (e.g., 46 screenshots)
3. **Pick up crates** and run them to the correct bin door:
   - Images, Documents, Videos, Audio, Archives, Code, Other
4. **Dust bunnies** chase you and knock crates loose
5. **Red crates** = exact duplicates (found by hash)
6. **Lit door** = suggested destination
7. A dropped crate changes nothing

**Real impact:** One delivery moves an entire group of files to the right folder!

---

### Receipt Rush 💰

**What it does:** Reviews and categorizes expenses from bank statements.

**How to play:**
1. Each **merchant** is a monster grown from its name
2. **Your turn** - Choose an action:
   - **FILE** - Pick a category (starred suggestion is usually right)
   - **CHECK** - View transaction details
   - **FLAG** - Mark for review
   - **SPARE** - Leave uncategorized
3. **Merchant attacks** - Dodge inside the bullet box:
   - Subscriptions spiral toward you
   - Big/duplicate charges fall like boulders
   - Regular merchants rain coins
4. **Results** - Generates categorized CSV, expense report, and merchant rules

**Real impact:** Your choices file real transactions and build a rules file for future auto-categorization!

---

### Lint Dungeon 🏰

**What it does:** Fixes lint errors in your codebase.

**How to play:**
1. Each **lint rule** is a foe:
   - Big rules = bosses
   - Fixable rules = crawling enemies
   - Others = flying enemies
2. **Weapons & Actions:**
   - **Fix Beam** - Runs ESLint's autofix for that rule only
   - **Hush Whip** - Adds disable comments to silence the rule
   - **Quest Scroll** - Writes the rule to `LINT_QUESTLOG.md` for later
3. **Hearts** - Whip candles to regain health
4. **Exit door** - Opens when the floor is clear
5. **Next floor** - Fresh lint pass with remaining issues

**Real impact:** Defeating a foe actually fixes or suppresses lint errors in your code!

---

## Calm Mode

Every cabinet has a **Calm mode** - the same chore as a plain table with no timer and no canvas.

**Features:**
- Native `<select>` dropdowns for each group
- "Apply suggestions to low-risk groups" button
- Works with keyboard only
- Screen reader friendly
- No game pressure

**When to use:**
- You prefer traditional interfaces
- You use assistive technology
- You want to process items more deliberately
- Game graphics aren't your thing

---

## Google Integration

### Sign in with Google

Connect your real Gmail and Drive accounts:

1. Click **"Sign in with Google"** in the masthead
2. First-time setup (about 2 minutes):
   - Create a Google Cloud project
   - Enable Gmail, Drive, and Sheets APIs
   - Configure OAuth consent screen
   - Create OAuth client ID (Desktop app)
   - Add credentials to `.env` file
3. Authorize ChoreCade to access your data

### What becomes available:

- **Inbox Invaders: Gmail** - Your real inbox
  - Only reads headers (never bodies)
  - Archive removes INBOX label
  - Trash uses Gmail's 30-day trash
  - Fully undoable from ledger

- **Folder Frenzy: Drive** - Your Google Drive
  - Sort files into folders
  - Duplicates found via checksum (no download)
  - Uses Drive's trash
  - Fully undoable

- **Export to Sheets** (for Receipt Rush)
  - Creates a new Google Sheet
  - Includes all transactions, categories, and totals
  - One-click export button

### Safety:

- OAuth 2.0 with PKCE (Google's recommended flow)
- Only refresh token stored locally
- Sign out revokes the grant at Google
- Scopes are minimal (`gmail.modify`, `drive`)
- Sheets values written as RAW (formulas stay text)

---

## The Ledger & Undo

### What is the Ledger?

The ledger (right sidebar) is a complete history of every real change:

- Shows what happened, when, and which chore did it
- Newest changes at the top
- Dry-run changes are marked
- Undone changes are crossed out

### How Undo Works

**Every change is undoable:**

1. Click the **Undo** button on any ledger entry
2. The change is reversed:
   - File moves are reversed if original spots are free
   - Lint undo refused if file was edited since
   - Gmail/Drive actions use their trash/restore
3. The entry is marked as "undone"

**Safety guarantees:**
- Undo is all-or-nothing (won't partially revert)
- Won't clobber your changes
- Nothing is ever permanently deleted

---

## Safety Features

ChoreCade is designed to be safe with your real data:

### Never Deletes Permanently
- "Trash" means:
  - Gmail's or Drive's trash (30-day retention)
  - Your mailbox's Trash folder
  - `.chorecade-trash/` folder you can inspect

### Only Deliberate Actions Count
- Dropped crates in Folder Frenzy change nothing
- Merchants only filed when you choose FILE/FLAG
- Lint foes only change code when defeated
- People are gold ships with shields (harder to trash)

### Conservative Unsubscribe
- Only RFC 8058 one-click POSTs (with `--one-click-unsubscribe`)
- Other links go to `unsubscribe-queue.md` for you to click
- Never fetches unsubscribe links with GET

### Dry Run Mode
```bash
npm start -- --files ~/Downloads --dry-run
```
- Journals what would happen
- Makes no actual changes
- Perfect for testing

### Server Security
- Binds to `127.0.0.1` only (localhost)
- Refuses DNS rebinding attacks
- Strict Content-Security-Policy
- Per-run session tokens
- Path containment (can't escape target folder)
- Symlinks refused

---

## Keyboard Shortcuts

### Global
- `Esc` - Exit current game / close overlay
- `Tab` - Navigate between elements
- `Enter` - Activate focused button/link

### Game Controls (varies by game)
- See in-game instructions for specific controls
- Each game shows its controls in an overlay before starting

### Calm Mode
- `Tab` - Navigate between rows
- `Space/Enter` - Open select dropdown
- Arrow keys - Navigate options
- `Enter` - Select option

---

## Accessibility

ChoreCade is designed to be accessible to everyone:

### Calm Mode
- Every chore has a calm mode variant
- No canvas, no timer, no game pressure
- Native HTML tables and form controls
- Fully keyboard navigable
- Screen reader friendly

### Visual Accessibility
- Skip link to main content
- Landmarks and ARIA labels throughout
- Visible focus rings on all interactive elements
- WCAG AA contrast ratios (4.5:1 or better)
- Clear color coding with text alternatives

### Motion Sensitivity
- `prefers-reduced-motion` support
- Turns off screen shake, blinking, guide arrows
- Reduces particle effects
- All animations can be disabled

### Screen Reader Support
- Live regions announce changes
- Dialog overlays are properly labelled
- Button labels are descriptive
- Progress bars have accessible labels
- Game stats are announced

### Self-Hosted Assets
- All fonts self-hosted (no third-party requests)
- Works offline after initial load
- No external dependencies for core functionality

---

## Tips for Success

### Start with Demo Mode
- Try everything in the demo sandbox first
- No risk to your real data
- Learn the game mechanics safely

### Use Grouping to Your Advantage
- One move = one group (not one item)
- 5,000 emails → ~150 senders → ~150 shots
- Trust the suggestions (ring, lit door, star)
- Override when you know better

### Check the Ledger
- Review what happened after each session
- Use undo if something went wrong
- Build confidence by seeing the history

### Use Calm Mode When Needed
- No shame in preferring calm mode
- Same real work, different interface
- Great for accessibility or focus

### Start Small
- Try with a small folder first
- Test with a few emails before your whole inbox
- Build up to bigger chores

---

## Need Help?

- Check the [README.md](README.md) for technical details
- Review the safety model above
- Use dry-run mode to test before live
- Every action is undoable from the ledger

---

**Enjoy turning your backlog into a game! 🎮**
