import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import LegalDocumentPage from '@/components/legal/LegalDocumentPage';
import { LegalPolicySection } from '@/components/legal/LegalPolicySection';

export default function TermsOfService() {
  return (
    <LegalDocumentPage
      title="Terms of Service"
      effectiveDate="Effective October 2026 · SEC Nightlife (&quot;SEC&quot;, &quot;the Platform&quot;)"
    >
      <LegalPolicySection title="1. Acceptance of Terms">
        <p>
          By accessing, registering for, downloading, or otherwise using the SEC platform, you expressly acknowledge and
          agree that you have read, understood, and are legally bound by these Terms of Service (&quot;Terms&quot;). These
          Terms constitute a legally binding agreement between you and SEC and govern your access to and use of all
          services, features, functionalities, and content made available through the Platform.
        </p>
        <p>
          These Terms apply to all categories of users, including but not limited to individual users, table hosts,
          promoters, venues, event companies, and freelance service providers. By using the Platform, you confirm that
          you possess the legal capacity to enter into binding agreements under the laws of the Republic of South Africa.
        </p>
        <p>
          SEC reserves the unilateral right to amend, update, or modify these Terms at any time, at its sole discretion.
          Such modifications may occur to reflect changes in applicable laws, regulatory requirements, platform
          functionality, or business practices. Updated Terms will be made available through the Platform, and continued
          use of SEC following such updates constitutes full acceptance of the revised Terms. Users are responsible for
          reviewing these Terms periodically.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="2. Platform Role and Nature of Services">
        <p>
          SEC operates exclusively as a digital technology platform and intermediary marketplace designed to facilitate
          connections between users, venues, promoters, and freelance service providers within the nightlife industry. The
          Platform provides infrastructure for event discovery, social networking, table booking, ticketing, job sourcing,
          and communication.
        </p>
        <p>
          Under no circumstances shall SEC be construed as an event organizer, venue operator, employer, agent, partner,
          or representative of any user, venue, promoter, or third party. SEC does not own, manage, control, supervise,
          or direct any real-world activity facilitated through the Platform. All events, services, and interactions are
          independently organized and executed by third parties.
        </p>
        <p>
          Users expressly acknowledge that SEC does not guarantee the accuracy, legality, safety, quality, or success of
          any event, booking, or service listed or facilitated through the Platform. All real-world participation occurs at
          the sole risk of the user.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="3. Eligibility and Legal Capacity">
        <p>
          Access to and use of the Platform is restricted to individuals who are legally permitted to engage in
          nightlife-related activities under applicable laws. In the Republic of South Africa, this includes compliance
          with legal drinking age requirements, public conduct regulations, and any other applicable statutory provisions.
        </p>
        <p>
          By using SEC, users represent and warrant that all information provided is accurate, complete, and not
          misleading. Users further warrant that they will comply with all applicable laws, regulations, and venue-specific
          requirements when participating in activities facilitated through the Platform.
        </p>
        <p>
          SEC reserves the right to request proof of age, identity, or legal eligibility at any time and to suspend or
          terminate accounts where such verification cannot be satisfactorily completed.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="4. User Accounts and Age Verification">
        <p>
          Users must create an account to access core functionalities of the Platform. You must provide accurate personal
          information, including your date of birth and gender, and accept our Age Verification Declaration to confirm you
          are 18 or older.
        </p>
        <p>
          Users are solely responsible for maintaining the confidentiality of their login credentials and for all
          activities conducted under their account. Any unauthorized use of an account must be reported immediately to
          SEC.
        </p>
        <p>
          SEC reserves the right to suspend or permanently terminate accounts that contain false, misleading, or fraudulent
          information, including misrepresentation of age or identity.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="5. Venue and Event Responsibility">
        <p>
          Venues and event organizers listed on SEC bear full and exclusive responsibility for the planning, execution,
          and management of all events. This includes compliance with all applicable laws, obtaining necessary licenses,
          ensuring adequate security, maintaining safe premises, and adhering to capacity limits.
        </p>
        <p>
          SEC does not guarantee entry to any event or venue and is not responsible for refusal of entry, overbooking,
          cancellations, or any incidents occurring on venue premises.
        </p>
        <p>
          Users acknowledge that venues retain absolute discretion regarding admission policies and enforcement of
          rules. Venues on SEC must also meet the standards in our{' '}
          <Link to={createPageUrl('VenueComplianceCharter')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Venue Compliance Charter
          </Link>
          .
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="6. Promoter and Freelancer Responsibilities">
        <p>
          Promoters and freelance service providers operate independently on the Platform and are solely responsible for
          fulfilling their obligations to users and venues. SEC does not employ, supervise, or control these individuals.
        </p>
        <p>
          Any agreements entered into between users and promoters or freelancers are strictly between those parties. SEC
          disclaims all liability arising from non-performance, disputes, or dissatisfaction with services. Promoter
          conduct is also governed by our{' '}
          <Link to={createPageUrl('PromoterCodeOfConduct')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Promoter Code of Conduct
          </Link>{' '}
          and{' '}
          <Link to={createPageUrl('CommunityGuidelines')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Community Guidelines
          </Link>
          .
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="7. Payments, Escrow, and Financial Transactions">
        <p>
          SEC facilitates payments through third-party providers. For supported flows, SEC may collect funds and apply
          platform splits (including SEC fees and partner earnings) as defined by product rules.
        </p>
        <p>
          <strong>Service fee.</strong> A flat SEC service fee of R5 is added to each paid checkout (for example tickets,
          entrance, table bookings, table joins, and menu orders) and is shown before you pay. The service fee covers
          payment processing and platform costs. It is separate from the venue or host price and is not shared with
          venues or hosts. The service fee is non-refundable, except where the event is cancelled, in which case SEC
          support will return it.
        </p>
        <p>
          <strong>Weekly payouts.</strong> Eligible earnings for venues and users (including hosts) are recorded in their
          Sec Wallet when a sale is confirmed and paid out in one combined bank transfer per recipient every Monday, once
          the recipient&apos;s outstanding balance is at least R50. Balances below R50 roll over to the following week.
          Payout timing may also depend on settlement by our payment partner and on bank processing times (typically
          1–2 business days, longer over weekends or public holidays).
        </p>
        <p>
          Payouts are sent to configured payout recipient details. If payout details are missing or invalid, earnings
          remain pending until corrected in your Sec Wallet (Profile for users, Business Dashboard for venues).
        </p>
        <p>
          Users acknowledge that all financial transactions are conducted at their own risk. Disputes regarding
          payments must be resolved directly between the relevant parties, subject to our{' '}
          <Link to={createPageUrl('RefundPolicy')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Refund Policy
          </Link>
          .
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="8. Refund Policy Integration">
        <p>
          Refund rules are set out in our{' '}
          <Link to={createPageUrl('RefundPolicy')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Refund Policy
          </Link>
          . In general, SEC does not issue refunds as a platform operator; venues and organizers bear primary
          responsibility for refunds where applicable. The R5 SEC service fee is only refunded when an event is
          cancelled.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="9. User Conduct and Platform Integrity">
        <p>
          Users agree to conduct themselves in a lawful, respectful, and ethical manner at all times. This includes both
          online interactions within the Platform and offline behavior at events facilitated through SEC. See also our{' '}
          <Link to={createPageUrl('UserAgreement')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            User Agreement
          </Link>{' '}
          and{' '}
          <Link to={createPageUrl('CommunityGuidelines')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Community Guidelines
          </Link>
          .
        </p>
        <p>
          SEC reserves broad enforcement rights, including content removal, account suspension, and permanent bans, to
          maintain platform integrity.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="10. Safety and Risk Disclaimer">
        <p>
          Users acknowledge that nightlife environments involve inherent risks, including injury, intoxication, and criminal
          activity. Participation in any event is undertaken at the user&apos;s sole risk.
        </p>
        <p>SEC bears no responsibility for incidents occurring at venues or events.</p>
      </LegalPolicySection>

      <LegalPolicySection title="11. Limitation of Liability">
        <p>
          To the fullest extent permitted by law, SEC shall not be liable for any direct or indirect damages arising from
          use of the Platform. This includes but is not limited to loss of profits, personal injury, reputational damage,
          or third-party actions.
        </p>
        <p>
          SEC&apos;s total liability shall not exceed the lesser of the amount paid by the user in the preceding 12 months
          or the minimum amount permitted under applicable law.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="12. Indemnification">
        <p>
          Users agree to indemnify and hold harmless SEC against any claims, damages, or legal proceedings arising from
          their use of the Platform or violation of these Terms.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="13. Dispute Resolution and Arbitration">
        <p>
          All disputes must be resolved through internal processes, followed by mediation and binding arbitration within
          South Africa. Users waive the right to pursue litigation or participate in class actions, to the extent permitted
          by law.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="14. Governing Law">
        <p>These Terms are governed exclusively by the laws of the Republic of South Africa.</p>
      </LegalPolicySection>

      <LegalPolicySection title="Related documents">
        <p>
          <Link to={createPageUrl('PrivacyPolicy')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Privacy Policy
          </Link>
          {' · '}
          <Link to={createPageUrl('UserAgreement')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            User Agreement
          </Link>
        </p>
      </LegalPolicySection>
    </LegalDocumentPage>
  );
}
