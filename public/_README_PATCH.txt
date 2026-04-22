═══════════════════════════════════════════════════════════════
  EJECTSEAT — UI PATCH (3 files)
═══════════════════════════════════════════════════════════════

WHAT'S CHANGED:
  1. No-match search ("auger" etc) now shows "Try another company"
     prompt instead of an option to score nonsense
  2. How-it-works page slimmed — no more IP exposure, just
     positioning + the score-meaning table
  3. Privacy + Terms pages created and wired to footer links

═══════════════════════════════════════════════════════════════
  HOW TO DEPLOY (5 minutes via GitHub web)
═══════════════════════════════════════════════════════════════

1. Go to your repo → click into the "public" folder
2. Click "Add file" → "Upload files"
3. Drag ALL THREE files from this patch folder in:
       index.html       (overwrites the existing one)
       privacy.html     (new file)
       terms.html       (new file)
4. Wait for green checkmarks
5. Commit message: "UI patch: no-match handling, slim how-it-works,
   add Privacy + Terms"
6. Click "Commit changes"
7. Vercel auto-deploys (~60-90 seconds)

═══════════════════════════════════════════════════════════════
  VERIFY
═══════════════════════════════════════════════════════════════

After Vercel finishes:

  1. Search "auger" → should show "No match found" card with
     a "Try another company →" button (no Score button anywhere)

  2. Click "How it works" in the nav → should show three short
     steps + the score-meaning table (much shorter than before)

  3. Scroll to footer → click "Privacy" → opens privacy.html
                     → click "Terms"   → opens terms.html

═══════════════════════════════════════════════════════════════
  IF YOU NEED TO CUSTOMISE THE LEGAL PAGES
═══════════════════════════════════════════════════════════════

The Privacy and Terms pages use:
  - Entity name:  Admin-Ace LLC
  - Contact:      enquiries.talkace@gmail.com
  - Last updated: 21 April 2026
  - Governing law: Delaware (Terms section 11)

To change any of these later, edit the file via GitHub web
(pencil icon → make changes → commit). Search for "Admin-Ace LLC"
or the email address to find every occurrence.

If you incorporate Admin-Ace LLC in a state other than Delaware
(or in another country), you'll want to update Terms section 11
to reflect the actual governing law and venue.

═══════════════════════════════════════════════════════════════
