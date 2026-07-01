// The waiver / Terms & Conditions shown (and accepted) at checkout.
//
// Source of truth: booking/WAIVER.md — keep this rendering in sync with it,
// and bump WAIVER_VERSION in wrangler.toml whenever the wording changes, so
// every booking records exactly which version was accepted. Content is
// static (no interpolations), so the html`` tag here is structural only.

import { html } from './html.js';

export const waiverHtml = html`
  <p><strong>Mini &amp; Co. Sensory Classes — Terms &amp; Conditions and Cancellation Policy</strong></p>
  <p>Business name: Mini &amp; Co. Baby Sensory / Mini &amp; Co.<br>
     Location: Oran Park Library / community venue, or another venue advised by Mini &amp; Co.<br>
     Contact: miniandco.classes@gmail.com</p>
  <p>By booking a Mini &amp; Co. sensory class, you agree to the following Terms &amp; Conditions.</p>

  <h3>1. About Mini &amp; Co. Sensory Classes</h3>
  <p>Mini &amp; Co. sensory classes are designed for babies aged approximately 3–12 months and provide a gentle, play-based sensory experience for babies and their parent or carer.</p>
  <p>Our classes are designed to support connection, curiosity and age-appropriate sensory exploration. They are not medical, therapeutic, diagnostic or childcare services. Parents and carers remain responsible for their child at all times during the class.</p>

  <h3>2. Parent / Carer Responsibility</h3>
  <p>A parent, guardian or responsible carer must remain with the child for the full duration of the class.</p>
  <p>You are responsible for supervising your baby at all times, including during sensory play, movement activities, use of props, and transitions in and out of the class space.</p>
  <p>Mini &amp; Co. takes reasonable care to create a safe and welcoming environment, but sensory classes involve movement, shared resources and baby-led exploration. Parents and carers must use their own judgment about whether an activity is suitable for their child.</p>

  <h3>3. Health, Illness and Safety</h3>
  <p>Please do not attend class if you, your baby, or anyone attending with you has symptoms of illness, including but not limited to: fever, vomiting or diarrhoea, contagious rash, persistent coughing, flu-like symptoms, suspected infectious illness, hand, foot and mouth disease, conjunctivitis, COVID-19, RSV, influenza or similar contagious conditions.</p>
  <p>This helps us protect babies, families and the wider community.</p>
  <p>Mini &amp; Co. reserves the right to ask a family not to participate if the child or attending adult appears visibly unwell or if attendance may pose a health risk to others.</p>

  <h3>4. Allergies and Sensitivities</h3>
  <p>Some sensory activities may include materials such as fabric, bubbles, textured items, food-based sensory materials, natural materials, water play or other age-appropriate sensory resources.</p>
  <p>Parents and carers must notify Mini &amp; Co. of any known allergies, sensitivities, medical conditions or relevant developmental considerations before attending class. Mini &amp; Co. will take reasonable care when planning activities, but we cannot guarantee a completely allergen-free environment, especially in shared community venues.</p>

  <h3>5. Bookings and Payment</h3>
  <p>Bookings are only confirmed once payment has been received. Places are limited and bookings are offered on a first-come, first-served basis. For term bookings, your booking secures your place in the nominated class time for the duration of the term, unless otherwise agreed. For casual or trial classes, your booking secures your place for the specific class date and time selected.</p>

  <h3>6. Cancellation Policy — Customer Cancellations</h3>
  <p>We understand that life with babies can be unpredictable. Our cancellation policy is designed to be fair while also recognising that classes have limited spaces and fixed venue, preparation and resource costs.</p>
  <p><strong>More than 48 hours before class:</strong> if you cancel more than 48 hours before your class, Mini &amp; Co. may offer one of the following, subject to availability: a class credit; transfer to another available class; or refund, less any non-refundable booking or processing fees, if applicable.</p>
  <p><strong>Less than 48 hours before class:</strong> if you cancel less than 48 hours before class, we may not be able to offer a refund, as your place has been held and resources may already have been prepared. Where possible, Mini &amp; Co. may offer a make-up class or credit at our discretion, subject to availability.</p>
  <p><strong>Same-day cancellation or non-attendance:</strong> if you do not attend a class, or cancel on the same day, no refund will usually be provided. A make-up class may be offered at Mini &amp; Co.'s discretion, subject to availability and the circumstances.</p>

  <h3>7. Missed Classes During a Term Booking</h3>
  <p>If you book for a term and miss a class, Mini &amp; Co. is not required to refund the missed class.</p>
  <p>Where possible, we may offer a make-up class during the same term, subject to availability. Make-up classes are not guaranteed and cannot be carried over to a future term unless agreed by Mini &amp; Co.</p>

  <h3>8. Cancellation by Mini &amp; Co.</h3>
  <p>If Mini &amp; Co. needs to cancel a class due to illness, venue issues, safety concerns, emergency, insufficient numbers, or circumstances outside our control, we will offer one of the following: a rescheduled class; a class credit; a make-up class; or a refund for the cancelled class. If Mini &amp; Co. is unable to provide a class that has been paid for, we will provide a suitable remedy in line with Australian Consumer Law.</p>

  <h3>9. Refunds and Australian Consumer Law</h3>
  <p>Nothing in these Terms &amp; Conditions excludes, restricts or modifies any rights you may have under Australian Consumer Law.</p>
  <p>You may be entitled to a remedy if a service is not provided with due care and skill, is not fit for purpose, or is not provided within a reasonable time where no time was agreed. However, refunds are not usually provided for change of mind, inability to attend, or circumstances outside Mini &amp; Co.'s control, unless required by law or agreed by Mini &amp; Co.</p>

  <h3>10. Transfers</h3>
  <p>If you are unable to attend a class, you may request to transfer your booking to another family.</p>
  <p>Transfers must be approved by Mini &amp; Co. before the class and the replacement child must meet the age requirements for the class.</p>
  <p>Mini &amp; Co. may refuse a transfer if the class is not suitable for the child's age, needs or circumstances.</p>

  <h3>11. Class Changes</h3>
  <p>Mini &amp; Co. may occasionally need to make changes to class content, resources, venue, instructor, timetable or structure.</p>
  <p>We will try to provide notice where possible, but some changes may occur at short notice due to safety, venue availability, illness or operational needs.</p>

  <h3>12. Photos and Videos</h3>
  <p>Parents and carers may take photos or videos of their own child during class, provided they do not photograph or record other children or families without permission.</p>
  <p>Mini &amp; Co. may occasionally take photos or videos for marketing purposes, but only with prior consent from the parent or guardian.</p>
  <p>You may withdraw photo consent at any time by contacting Mini &amp; Co.</p>

  <h3>13. Behaviour and Respectful Participation</h3>
  <p>Mini &amp; Co. aims to create a calm, inclusive and respectful environment for babies and families.</p>
  <p>We ask all adults attending class to behave respectfully towards other families, children, staff, venue staff and the class environment.</p>
  <p>Mini &amp; Co. reserves the right to refuse attendance or end participation if behaviour is unsafe, disrespectful, aggressive or disruptive.</p>

  <h3>14. Use of Resources and Equipment</h3>
  <p>All class resources, props and equipment remain the property of Mini &amp; Co. unless otherwise stated.</p>
  <p>Parents and carers must ensure their child uses resources safely and appropriately. Any mouthing of toys or resources is expected in baby classes, and Mini &amp; Co. will take reasonable steps to clean and maintain resources.</p>
  <p>Please notify the instructor immediately if any item appears damaged, unsafe or unsuitable.</p>

  <h3>15. Food and Drink</h3>
  <p>Food may only be included in class activities if specifically planned and communicated by Mini &amp; Co.</p>
  <p>Parents and carers are responsible for advising Mini &amp; Co. of any allergies or dietary restrictions before participating in any food-based sensory activity.</p>
  <p>Personal snacks and drinks should be managed carefully to reduce allergy and choking risks around other babies.</p>

  <h3>16. Liability</h3>
  <p>Mini &amp; Co. will take reasonable care to provide a safe and age-appropriate class environment.</p>
  <p>To the extent permitted by law, Mini &amp; Co. is not liable for injury, loss or damage arising from: failure by a parent or carer to supervise their child; failure to follow safety instructions; pre-existing medical conditions or allergies not disclosed to Mini &amp; Co.; normal risks associated with baby movement, play and sensory exploration; venue-related issues outside Mini &amp; Co.'s reasonable control. Nothing in this clause limits your rights under Australian Consumer Law.</p>

  <h3>17. Personal Belongings</h3>
  <p>Mini &amp; Co. is not responsible for lost, stolen or damaged personal belongings brought to class.</p>
  <p>Please keep valuables with you at all times.</p>

  <h3>18. Privacy</h3>
  <p>Mini &amp; Co. collects personal information such as parent/carer name, child's name and age, contact details, emergency contact information, allergy information and booking details for the purpose of managing bookings, class safety and communication.</p>
  <p>Your information will not be sold or shared with third parties except where required by law, necessary for safety, or with your consent.</p>

  <h3>19. Agreement</h3>
  <p>By booking or attending a Mini &amp; Co. class, you confirm that: you have read and understood these Terms &amp; Conditions; you agree to the cancellation policy; you are responsible for supervising your child at all times; you have disclosed any relevant allergies, medical conditions or safety concerns; you understand that Mini &amp; Co. sensory classes are play-based educational sessions, not medical, therapeutic or childcare services.</p>
`;
