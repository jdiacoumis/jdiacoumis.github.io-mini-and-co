function sendWelcomesToNewBookings() {
  const props = PropertiesService.getScriptProperties();
  const stripeKey = props.getProperty("STRIPE_API_KEY");
  const sheetId = props.getProperty("SHEET_ID");
  const pdfFileId = props.getProperty("PDF_FILE_ID");

  // Look at charges from the last 24h. Dedupe handles repeats.
  const sinceTs = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const url = `https://api.stripe.com/v1/charges?created[gte]=${sinceTs}&limit=100`;

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + stripeKey },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    console.error("Stripe API error: " + response.getContentText());
    return;
  }

  const charges = JSON.parse(response.getContentText()).data;

  // Load already-welcomed emails from the sheet
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName("Welcomed");
  const existing = sheet
    .getRange("A:A")
    .getValues()
    .flat()
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());
  const welcomedSet = new Set(existing);

  const pdfBlob = DriveApp.getFileById(pdfFileId).getBlob();
  let sentCount = 0;

  for (const charge of charges) {
    if (charge.status !== "succeeded") continue;

    // Email can live in a few places — check all
    const email =
      (charge.billing_details && charge.billing_details.email) ||
      charge.receipt_email ||
      null;
    if (!email) continue;

    const emailLower = email.toLowerCase();
    if (welcomedSet.has(emailLower)) continue;

    const name = (charge.billing_details && charge.billing_details.name) || "";

    try {
      sendWelcomeEmail(email, name, pdfBlob);
      sheet.appendRow([emailLower, name, new Date(), charge.id]);
      welcomedSet.add(emailLower);
      sentCount++;
    } catch (err) {
      console.error(`Failed to send to ${email}: ${err}`);
    }
  }

  console.log(`Done. Sent ${sentCount} welcome emails.`);
}

function sendWelcomeEmail(toEmail, name, pdfBlob) {
  const subject = "Welcome to Mini & Co. Sensory Classes";

  // Plain text fallback (for clients that don't render HTML)
  const plainBody = `Hi lovely,

Thank you so much for booking with Mini & Co. Sensory Classes. I'm so excited to welcome you and your little one.

Your booking is now confirmed.

I've also attached a little Welcome Pack with some helpful information about the class. Please have a read through it before attending, so you feel comfortable and know what to expect.

What to expect
Mini & Co. is a calm, gentle sensory class designed to support your little one's development while also creating a welcoming space for mums to connect, slow down, and feel part of a community.

What to bring
You don't need to bring much, just yourself, your baby, and anything your little one may need such as a bottle, dummy, comforter, or spare clothes. You're also welcome to bring a small blanket if you'd like.

A little note
Please don't worry if your little one needs to feed, cuddle, cry, sleep, or have a break during the class. This is a baby-led space, and you are welcome exactly as you are.

Location
Mini & Co. Sensory Classes
Oran Park Library
72 Central Avenue, Oran Park NSW 2570

I can't wait to meet you both.

With love,
Camila`;

  // HTML version (what most parents will actually see)
  const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333; max-width: 600px;">

  <p>Hi lovely,</p>

  <p>Thank you so much for booking with <strong>Mini &amp; Co. Sensory Classes</strong>. I'm so excited to welcome you and your little one.</p>

  <p>Your booking is now confirmed.</p>

  <p>I've also attached a little Welcome Pack with some helpful information about the class. Please have a read through it before attending, so you feel comfortable and know what to expect.</p>

  <p style="font-weight: 600; font-size: 17px; margin-top: 28px; margin-bottom: 4px;">What to expect</p>
  <p style="margin-top: 0;">Mini &amp; Co. is a calm, gentle sensory class designed to support your little one's development while also creating a welcoming space for mums to connect, slow down, and feel part of a community.</p>

  <p style="font-weight: 600; font-size: 17px; margin-top: 28px; margin-bottom: 4px;">What to bring</p>
  <p style="margin-top: 0;">You don't need to bring much &mdash; just yourself, your baby, and anything your little one may need such as a bottle, dummy, comforter, or spare clothes. You're also welcome to bring a small blanket if you'd like.</p>

  <p style="font-weight: 600; font-size: 17px; margin-top: 28px; margin-bottom: 4px;">A little note</p>
  <p style="margin-top: 0;">Please don't worry if your little one needs to feed, cuddle, cry, sleep, or have a break during the class. This is a baby-led space, and you are welcome exactly as you are.</p>

  <p style="font-weight: 600; font-size: 17px; margin-top: 28px; margin-bottom: 4px;">Location</p>
  <p style="margin-top: 0;">
    Mini &amp; Co. Sensory Classes<br>
    Oran Park Library<br>
    72 Central Avenue, Oran Park NSW 2570
  </p>

  <p style="margin-top: 32px;">I can't wait to meet you both.</p>

  <p style="margin-top: 24px;">With love,<br>Camila</p>

</div>`;

  GmailApp.sendEmail(toEmail, subject, plainBody, {
    htmlBody: htmlBody,
    attachments: [pdfBlob],
  });
}

function setupTrigger() {
  // Remove any existing triggers for this function first
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "sendWelcomesToNewBookings") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("sendWelcomesToNewBookings")
    .timeBased()
    .everyMinutes(30)
    .create();

  console.log("Trigger created — runs every 30 minutes.");
}

// TEST 1: Send a sample welcome email to yourself
// Edit YOUR_TEST_EMAIL below before running
function testSendWelcomeEmail() {
  const props = PropertiesService.getScriptProperties();
  const pdfFileId = props.getProperty("PDF_FILE_ID");
  const fromName = props.getProperty("FROM_NAME") || "Camila";

  const pdfBlob = DriveApp.getFileById(pdfFileId).getBlob();

  const YOUR_TEST_EMAIL = "james.diacoumis2@gmail.com"; // change if you want

  sendWelcomeEmail(YOUR_TEST_EMAIL, "Test Parent", pdfBlob, fromName);
  console.log("Test email sent to " + YOUR_TEST_EMAIL);
}

// TEST 2: Check Stripe connection — lists recent charges, sends nothing
function testStripeConnection() {
  const props = PropertiesService.getScriptProperties();
  const stripeKey = props.getProperty("STRIPE_API_KEY");

  // Wider 30-day window so we definitely catch something
  const sinceTs = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const url = `https://api.stripe.com/v1/charges?created[gte]=${sinceTs}&limit=10`;

  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + stripeKey },
    muteHttpExceptions: true,
  });

  console.log("HTTP status: " + response.getResponseCode());
  if (response.getResponseCode() !== 200) {
    console.error("Stripe error: " + response.getContentText());
    return;
  }

  const charges = JSON.parse(response.getContentText()).data;
  console.log(`Found ${charges.length} charges in last 30 days:`);
  charges.forEach((c) => {
    const email =
      (c.billing_details && c.billing_details.email) ||
      c.receipt_email ||
      "(no email)";
    const name = (c.billing_details && c.billing_details.name) || "(no name)";
    console.log(
      `  - ${name} | ${email} | ${c.status} | ${new Date(c.created * 1000).toISOString()}`,
    );
  });
}

// TEST 3: Simulate a first-time booking end-to-end
// Tests email send AND sheet write, then verifies dedup on second run
function testFullFlowOnce() {
  const props = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.openById(
    props.getProperty("SHEET_ID"),
  ).getSheetByName("Welcomed");
  const pdfBlob = DriveApp.getFileById(
    props.getProperty("PDF_FILE_ID"),
  ).getBlob();
  const fromName = props.getProperty("FROM_NAME") || "Camila";

  const TEST_EMAIL = "james.diacoumis2@gmail.com"; // edit if you want
  const TEST_NAME = "James D";

  // Same dedup check the real script uses
  const existing = sheet
    .getRange("A:A")
    .getValues()
    .flat()
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());

  if (existing.includes(TEST_EMAIL.toLowerCase())) {
    console.log(
      `✋ ${TEST_EMAIL} is already in the sheet — skipping (dedup is working).`,
    );
    console.log("To re-test: delete that row from the sheet, then run again.");
    return;
  }

  // First-time path: send + record
  sendWelcomeEmail(TEST_EMAIL, TEST_NAME, pdfBlob, fromName);
  sheet.appendRow([
    TEST_EMAIL.toLowerCase(),
    TEST_NAME,
    new Date(),
    "test_" + Date.now(),
  ]);

  console.log(`✅ Sent welcome to ${TEST_EMAIL} and added row to sheet.`);
  console.log(
    "Run this function again — it should now skip and confirm dedup.",
  );
}

// ONE-SHOT BACKFILL: adds all historical Stripe customer emails to the sheet
// so they're skipped by the welcome trigger. Sends NO emails. Run once, before
// enabling the trigger. Safe to run again — won't duplicate rows.
function backfillExistingCustomers() {
  const props = PropertiesService.getScriptProperties();
  const stripeKey = props.getProperty("STRIPE_API_KEY");
  const sheetId = props.getProperty("SHEET_ID");

  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName("Welcomed");

  // Load whatever's already in the sheet to avoid duplicate rows
  const existing = sheet
    .getRange("A:A")
    .getValues()
    .flat()
    .filter(Boolean)
    .map((e) => String(e).toLowerCase());
  const welcomedSet = new Set(existing);

  let startingAfter = null;
  let hasMore = true;
  let totalProcessed = 0;
  const rowsToAdd = [];

  while (hasMore) {
    let url = "https://api.stripe.com/v1/charges?limit=100";
    if (startingAfter) url += "&starting_after=" + startingAfter;

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: "Bearer " + stripeKey },
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() !== 200) {
      console.error("Stripe error: " + response.getContentText());
      break;
    }

    const data = JSON.parse(response.getContentText());
    const charges = data.data;

    for (const charge of charges) {
      totalProcessed++;
      if (charge.status !== "succeeded") continue;

      const email =
        (charge.billing_details && charge.billing_details.email) ||
        charge.receipt_email ||
        null;
      if (!email) continue;

      const emailLower = email.toLowerCase();
      if (welcomedSet.has(emailLower)) continue;

      const name =
        (charge.billing_details && charge.billing_details.name) || "";
      rowsToAdd.push([emailLower, name, new Date(), "BACKFILL_" + charge.id]);
      welcomedSet.add(emailLower);
    }

    hasMore = data.has_more;
    if (hasMore && charges.length > 0) {
      startingAfter = charges[charges.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  // Bulk write — faster than appending row by row
  if (rowsToAdd.length > 0) {
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, rowsToAdd.length, 4).setValues(rowsToAdd);
  }

  console.log(
    `Backfill done. Processed ${totalProcessed} charges, added ${rowsToAdd.length} new customers.`,
  );
  console.log(
    "No welcome emails were sent. These customers will be skipped going forward.",
  );
}
