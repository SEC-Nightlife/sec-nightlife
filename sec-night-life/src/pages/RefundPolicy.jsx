import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import LegalDocumentPage from '@/components/legal/LegalDocumentPage';
import { LegalPolicySection } from '@/components/legal/LegalPolicySection';

export default function RefundPolicy() {
  return (
    <LegalDocumentPage
      title="Refund Policy"
      effectiveDate="Effective October 2026 · Republic of South Africa"
    >
      <LegalPolicySection title="1. Platform Role and Limitation of Responsibility">
        <p>
          SEC operates strictly as a digital facilitator of transactions between users and venues. SEC does not own,
          control, or manage event operations or financial outcomes and does not issue refunds as a platform operator in
          the ordinary course.
        </p>
        <p>
          All payments made through the Platform are transactions between users and venues (or other counterparties); SEC&apos;s
          role is limited to facilitating these interactions through payment partners.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="2. Venue Responsibility for Refunds">
        <p>
          Venues bear full and exclusive responsibility for handling refund requests, cancellations, and financial
          disputes related to their events and offerings. Users agree that any request for a refund must be directed to
          the venue or event organizer responsible.
        </p>
        <p>
          SEC may provide communication tools to facilitate this process but is not obligated to intervene or enforce
          refund decisions. Venue obligations are also described in our{' '}
          <Link to={createPageUrl('VenueComplianceCharter')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Venue Compliance Charter
          </Link>
          .
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="3. In-app refund requests">
        <p>
          For eligible ticket purchases and venue table bookings (event tables, day bookings, and custom tables), users
          may submit a refund request in the SEC app from Profile → Tickets or the refund request flow. You must provide
          your reason and your Sec Wallet ID so the venue can pay you off-app if they approve.
        </p>
        <p>
          SEC does not process or fund refunds. If a venue approves your request, they pay you directly (typically via
          bank transfer after looking up your Sec Wallet ID). SEC retains its 15% platform fee on the original
          transaction; the venue refund amount is 85% of the ticket, table, or menu price you paid.
        </p>
        <p>
          The flat R5 SEC service fee added at checkout is non-refundable, except where the event is cancelled. In that
          case, contact SEC support and we will return the service fee.
        </p>
        <p>
          When a refund is approved, your QR codes and tickets for that purchase are invalidated, table or ticket capacity
          is restored for other guests, and the booking is removed from active revenue reporting. You may submit a new
          request if a previous request was declined.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="4. Refund Eligibility and Conditions">
        <p>
          Refund eligibility is determined solely by the venue&apos;s policies and applicable laws. Circumstances under which
          refunds may be considered can include event cancellation, venue closure, or failure to deliver the promised
          service—subject to the venue&apos;s terms. If an event is cancelled, SEC will also return the R5 service fee
          on request.
        </p>
        <p>
          Users acknowledge that refunds will not typically be granted for reasons such as failure to attend, late
          arrival, or violation of venue rules, unless required by law or the venue&apos;s stated policy.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="5. Escrow and Payment Processing">
        <p>
          SEC collects payments through payment partners (including Paystack) and applies the platform split for
          applicable transactions. Where payout recipient details are configured, eligible venue or user earnings are
          combined and transferred weekly, every Monday, once the recipient&apos;s balance is at least R50. Smaller
          balances roll over to the next week.
        </p>
        <p>
          If recipient setup is missing, payout records may remain in a pending state until details are added in
          your Sec Wallet. SEC does not guarantee transfer timing in cases caused by missing, invalid, or
          rejected recipient details.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="6. Dispute Handling and Escalation">
        <p>
          Users are required to first contact the venue directly to resolve refund-related issues. If a dispute remains
          unresolved, users may escalate through SEC&apos;s support channels for administrative facilitation.
        </p>
        <p>SEC&apos;s involvement in disputes is limited to facilitation and does not constitute acceptance of liability.</p>
      </LegalPolicySection>

      <LegalPolicySection title="7. Fraud Prevention and Enforcement">
        <p>
          SEC reserves the right to investigate suspected fraudulent activity related to refund claims, including review of
          transaction data, communication logs, and user behavior.
        </p>
        <p>
          Users found to be engaging in fraudulent refund claims may face account suspension or termination, in addition to
          any legal remedies.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="Related documents">
        <p>
          <Link to={createPageUrl('TermsOfService')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Terms of Service
          </Link>
          {' · '}
          <Link to={createPageUrl('PrivacyPolicy')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Privacy Policy
          </Link>
        </p>
      </LegalPolicySection>
    </LegalDocumentPage>
  );
}
