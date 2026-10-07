import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import LegalDocumentPage from '@/components/legal/LegalDocumentPage';
import { LegalPolicySection } from '@/components/legal/LegalPolicySection';

export default function VenueComplianceCharter() {
  return (
    <LegalDocumentPage
      title="Venue Compliance Charter"
      effectiveDate="Governing law: Republic of South Africa · Effective October 2026"
    >
      <LegalPolicySection title="1. Purpose and Scope">
        <p>
          This Venue Compliance Charter (&quot;Charter&quot;) establishes the legal, operational, and ethical obligations of all
          venues, event companies, and nightlife establishments (&quot;Venues&quot;) that utilize the SEC platform. This Charter
          is designed to ensure that all Venues operating through SEC adhere to high standards of legal compliance,
          safety, transparency, and professional conduct within the nightlife ecosystem.
        </p>
        <p>
          By registering and operating on the SEC platform, Venues agree to be bound by this Charter in addition to all
          other applicable SEC policies, including the{' '}
          <Link to={createPageUrl('TermsOfService')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Terms of Service
          </Link>
          ,{' '}
          <Link to={createPageUrl('PrivacyPolicy')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Privacy Policy
          </Link>
          , and{' '}
          <Link to={createPageUrl('UserAgreement')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            User Agreement
          </Link>
          . This Charter governs all interactions between Venues and users facilitated through the Platform and applies to
          both digital representations of events and real-world execution.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="2. Legal Compliance and Licensing">
        <p>
          Venues are required to operate in full compliance with all applicable laws and regulations of the country, state,
          province, and municipality in which they operate. This includes, but is not limited to, obtaining and maintaining
          valid licenses for alcohol service, entertainment operations, public gatherings, and business registration, and
          complying with local age limits, trading hours, consumer protection, tax, data protection, and employment laws.
        </p>
        <p>
          Venues must ensure that all required documentation, including business registration, tax compliance records,
          annual returns, and valid liquor licenses (for South African Venues: CIPC registration, SARS compliance records,
          and liquor licenses issued under South African law, or the local equivalents in other countries), are accurate,
          current, and submitted during onboarding. Venues are solely responsible for ensuring that such documentation
          remains valid and up to date at all times.
        </p>
        <p>
          Venues operating outside South Africa remain bound by the laws of their own jurisdiction. This Charter and any
          dispute arising from it remain governed by the laws of the Republic of South Africa, without limiting any
          mandatory local law that applies to the Venue.
        </p>
        <p>
          SEC reserves the right to request updated compliance documentation at any time and may suspend or remove Venue
          listings where compliance cannot be verified.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="3. Safety and Security Obligations">
        <p>
          Venues bear full responsibility for ensuring the safety and well-being of all individuals attending events hosted
          at their premises. This includes implementing appropriate security measures, employing qualified personnel,
          maintaining emergency response procedures, and adhering to legally mandated capacity limits.
        </p>
        <p>
          Venues must ensure that their premises are structurally safe, that fire safety regulations are met, and that all
          necessary precautions are taken to prevent overcrowding, violence, or hazardous conditions. SEC does not assume
          any responsibility for safety failures or incidents occurring at Venue premises.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="4. Alcohol Service Responsibility">
        <p>
          Venues are exclusively responsible for the lawful and responsible service of alcohol. This includes verifying the
          legal drinking age of patrons, preventing over-service, and ensuring compliance with all alcohol-related
          regulations.
        </p>
        <p>
          SEC does not participate in or control alcohol service in any capacity. Any liability arising from alcohol-related
          incidents, including intoxication, injury, or legal violations, rests solely with the Venue.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="5. Event Transparency and Accuracy">
        <p>
          Venues must ensure that all event listings, descriptions, pricing, and availability information presented on the
          Platform are accurate, truthful, and not misleading. This includes clear communication of entry requirements,
          dress codes, minimum spends, and any restrictions applicable to attendees.
        </p>
        <p>
          Misrepresentation of events or services constitutes a violation of this Charter and may result in enforcement
          action by SEC, including suspension or removal from the Platform.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="6. Menu Maker and Venue Menu Listings">
        <p>
          SEC may offer a &quot;Menu Maker&quot; tool listing common drinks, food, and other items to help venues build menus
          faster. These listings are suggestions only: SEC does not sell, stock, supply, or endorse any product shown in
          Menu Maker.
        </p>
        <p>
          Venues are solely responsible for the accuracy of menu names, prices, photos, descriptions, and what is actually
          served to guests. Venues must upload their own photos of items they offer. SEC is a technology and booking
          platform only and is not a party to food or beverage service at venue premises.
        </p>
        <p>
          Any claim arising from menu misrepresentation, product quality, allergic reactions, or service of alcohol or food
          is between the guest and the venue, except where applicable law requires otherwise.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="7. Financial Responsibility and Refund Obligations">
        <p>
          Venues acknowledge and agree that they bear full responsibility for all financial transactions related to their
          events, including refunds, cancellations, and disputes. SEC operates solely as a facilitator and does not
          assume liability for financial outcomes.
        </p>
        <p>
          Venue earnings (after the SEC platform split) are recorded in the venue&apos;s Sec Wallet and paid out in one
          combined bank transfer every Monday once the outstanding balance is at least R50; smaller balances roll over to
          the following week. Guests pay a separate flat R5 SEC service fee at checkout, which is not part of venue
          earnings and is not refunded by venues. Venues are responsible for keeping their Sec Wallet bank details
          accurate so payouts are not delayed.
        </p>
        <p>
          Venues must establish and honor fair refund policies and are required to address user refund requests directly.
          Failure to do so may result in removal from the Platform. See our{' '}
          <Link to={createPageUrl('RefundPolicy')} className="underline font-medium" style={{ color: 'var(--sec-accent)' }}>
            Refund Policy
          </Link>
          .
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="8. Non-Discrimination and Fair Access">
        <p>
          Venues must operate in a manner that is consistent with South African anti-discrimination laws. While Venues
          retain the right to enforce entry policies such as dress codes and capacity limits, such policies must not
          unlawfully discriminate against individuals based on protected characteristics.
        </p>
      </LegalPolicySection>

      <LegalPolicySection title="9. Enforcement and Platform Rights">
        <p>
          SEC reserves the right to monitor Venue compliance and to take enforcement action where violations occur. This
          includes the right to suspend listings, restrict access, or permanently remove Venues from the Platform.
        </p>
      </LegalPolicySection>
    </LegalDocumentPage>
  );
}
