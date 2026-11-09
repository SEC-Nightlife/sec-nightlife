import React from 'react';
import { dataService } from '@/services/dataService';
import { useQuery } from '@tanstack/react-query';
import { Trophy, Star, Users, Briefcase, ShieldCheck, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import SecLogo from '@/components/ui/SecLogo';

export default function Leaderboard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['promoters-leaderboard'],
    queryFn: async () => {
      return dataService.Leaderboard.promoters({ page: 1, limit: 50 });
    }
  });
  const { data: myStatus } = useQuery({
    queryKey: ['promoter-me-status'],
    queryFn: () => dataService.Promoters.myStatus(),
  });
  const { data: weekData } = useQuery({
    queryKey: ['promoter-week'],
    queryFn: () => dataService.Promoters.weekLeaderboard(),
  });
  const promoters = data?.data || [];
  const policy = data?.policy || null;
  const topThree = promoters.slice(0, 3);
  const rest = promoters.slice(3);

  const getRankStyle = (index) => {
    if (index === 0) return { bg: 'var(--sec-accent)', color: 'var(--sec-bg-base)' };
    if (index === 1) return { bg: 'var(--sec-silver)', color: 'var(--sec-bg-base)' };
    if (index === 2) return { bg: 'var(--sec-accent-muted)', color: 'var(--sec-accent)', border: '1px solid var(--sec-accent)' };
    return { bg: 'var(--sec-bg-elevated)', color: 'var(--sec-text-muted)', border: '1px solid var(--sec-border)' };
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--sec-bg-base)', padding: '48px 0' }}>
        <div className="sec-spinner" />
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: 'var(--sec-bg-base)', padding: 'var(--space-6)' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <SecLogo size={40} variant="full" />
            <Trophy size={24} strokeWidth={1.5} style={{ color: 'var(--sec-accent)' }} />
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 8 }}>Promoter Leaderboard</h1>
          <p style={{ fontSize: 14, color: 'var(--sec-text-muted)' }}>Top-performing verified promoters on SEC</p>
          {policy && (
            <div style={{ marginTop: 14, display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--sec-text-muted)' }}>
              <Info size={13} />
              <span>Ranking combines quality, execution, consistency, and compliance.</span>
            </div>
          )}
        </div>

        {myStatus ? (
          <div className="sec-card" style={{ padding: 16, marginBottom: 16, borderColor: myStatus.featured ? 'var(--sec-accent-border)' : undefined }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 8 }}>Your promoter progress</h2>
            {myStatus.featured ? (
              <p style={{ fontSize: 13, color: 'var(--sec-text-primary)' }}>
                Rank #{myStatus.rank} · Score {myStatus.score?.toFixed?.(1) || myStatus.score} · {myStatus.conversionPoints || 0} conversion pts
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--sec-text-muted)', lineHeight: 1.6 }}>
                {(myStatus.nextSteps || []).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            )}
            <Link to={createPageUrl('PromoterCodeOfConduct')} style={{ fontSize: 12, color: 'var(--sec-accent)', marginTop: 8, display: 'inline-block' }}>
              Read verification guide
            </Link>
          </div>
        ) : null}

        {(weekData?.data || []).length > 0 ? (
          <div className="sec-card" style={{ padding: 16, marginBottom: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 10 }}>Promoter of the week</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {weekData.data.map((p, i) => (
                <Link key={p.promoterId} to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(p.promoterId)}`} style={{ textDecoration: 'none' }}>
                  <span className="sec-badge" style={{ fontSize: 12 }}>
                    {i + 1}. @{p.username} · {p.points} pts
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="sec-card" style={{ padding: 16, marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--sec-text-primary)', marginBottom: 8 }}>How to get featured</h2>
          <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginBottom: 6 }}>
            Become a verified promoter, complete at least 20 accepted promoter jobs, earn ratings and referral conversions, and accept the Promoter Code of Conduct.
          </p>
          {policy && (
            <p style={{ fontSize: 12, color: 'var(--sec-text-muted)' }}>
              Baseline thresholds: {policy.minAcceptedJobs}+ accepted jobs, {policy.minRatings}+ ratings, {policy.minUniqueRaters}+ unique raters.
            </p>
          )}
        </div>

        {topThree.length >= 3 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 32, alignItems: 'end' }}>
            <Link to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(topThree[1].promoterId)}`} style={{ textDecoration: 'none' }}>
              <div className="sec-card" style={{ padding: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--sec-silver)', marginBottom: 12 }}>2</div>
                <div style={{ width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', margin: '0 auto 12px', border: '2px solid var(--sec-border)' }}>
                  {topThree[1].avatarUrl ? (
                    <img src={topThree[1].avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', backgroundColor: 'var(--sec-bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 600, color: 'var(--sec-text-muted)' }}>
                      {topThree[1].username?.[0] || 'U'}
                    </div>
                  )}
                </div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-primary)' }}>{topThree[1].username}</h3>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 }}>
                  <Star size={16} strokeWidth={1.5} fill="var(--sec-accent)" stroke="var(--sec-accent)" />
                  <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>{topThree[1].ratingAvg?.toFixed(1)}</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>{topThree[1].ratingCount} ratings</p>
              </div>
            </Link>

            <Link to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(topThree[0].promoterId)}`} style={{ textDecoration: 'none' }}>
              <div className="sec-card" style={{ padding: 24, textAlign: 'center', borderColor: 'var(--sec-accent-border)' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--sec-accent)', marginBottom: 12 }}>1</div>
                <div style={{ width: 80, height: 80, borderRadius: '50%', overflow: 'hidden', margin: '0 auto 12px', border: '2px solid var(--sec-accent)' }}>
                  {topThree[0].avatarUrl ? (
                    <img src={topThree[0].avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', backgroundColor: 'var(--sec-bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 600, color: 'var(--sec-text-muted)' }}>
                      {topThree[0].username?.[0] || 'U'}
                    </div>
                  )}
                </div>
                <h3 style={{ fontSize: 17, fontWeight: 600, color: 'var(--sec-text-primary)' }}>{topThree[0].username}</h3>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 }}>
                  <Star size={18} strokeWidth={1.5} fill="var(--sec-accent)" stroke="var(--sec-accent)" />
                  <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--sec-accent)' }}>{topThree[0].ratingAvg?.toFixed(1)}</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>{topThree[0].ratingCount} ratings</p>
              </div>
            </Link>

            <Link to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(topThree[2].promoterId)}`} style={{ textDecoration: 'none' }}>
              <div className="sec-card" style={{ padding: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--sec-text-muted)', marginBottom: 12 }}>3</div>
                <div style={{ width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', margin: '0 auto 12px', border: '2px solid var(--sec-border)' }}>
                  {topThree[2].avatarUrl ? (
                    <img src={topThree[2].avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', backgroundColor: 'var(--sec-bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 600, color: 'var(--sec-text-muted)' }}>
                      {topThree[2].username?.[0] || 'U'}
                    </div>
                  )}
                </div>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-primary)' }}>{topThree[2].username}</h3>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 }}>
                  <Star size={16} strokeWidth={1.5} fill="var(--sec-accent)" stroke="var(--sec-accent)" />
                  <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>{topThree[2].ratingAvg?.toFixed(1)}</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>{topThree[2].ratingCount} ratings</p>
              </div>
            </Link>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(topThree.length < 3 ? promoters : rest).map((promoter, index) => {
            const actualIndex = index + 3;
            const displayRank = topThree.length < 3 ? promoter.rank : actualIndex + 1;
            const rankStyle = getRankStyle(displayRank - 1);
            return (
              <Link key={promoter.promoterId} to={`${createPageUrl('UserProfile')}?id=${encodeURIComponent(promoter.promoterId)}`} style={{ textDecoration: 'none' }}>
                <div className="sec-card" style={{ padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 600, fontSize: 13, backgroundColor: rankStyle.bg, color: rankStyle.color, border: rankStyle.border
                    }}>
                      {displayRank}
                    </div>
                    <div style={{ width: 48, height: 48, borderRadius: '50%', overflow: 'hidden', border: '1px solid var(--sec-border)' }}>
                      {promoter.avatarUrl ? (
                        <img src={promoter.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ width: '100%', height: '100%', backgroundColor: 'var(--sec-bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, color: 'var(--sec-text-muted)' }}>
                          {promoter.username?.[0] || 'U'}
                        </div>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--sec-text-primary)' }}>{promoter.username}</h3>
                      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 4 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Briefcase size={12} strokeWidth={1.5} />
                          {promoter.completedJobs || 0} jobs
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Users size={12} strokeWidth={1.5} />
                          {promoter.ratingCount || 0} ratings
                        </span>
                        {(promoter.conversionPoints || 0) > 0 ? (
                          <span>{promoter.conversionPoints} conv. pts</span>
                        ) : null}
                      </div>
                      {promoter.badges?.compliant && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--sec-accent)', marginTop: 4 }}>
                          <ShieldCheck size={12} />
                          Compliant
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                        <Star size={16} strokeWidth={1.5} fill="var(--sec-accent)" stroke="var(--sec-accent)" />
                        <span style={{ fontWeight: 600, color: 'var(--sec-text-primary)' }}>{promoter.ratingAvg?.toFixed(1)}</span>
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--sec-text-muted)', marginTop: 2 }}>Score {promoter.score?.toFixed?.(1) || promoter.score}</p>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {isError && (
          <div style={{ textAlign: 'center', padding: '24px 24px', color: 'var(--sec-error)' }}>
            Could not load leaderboard right now.
          </div>
        )}

        {promoters.length === 0 && !isError && (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <Trophy size={48} strokeWidth={1.5} style={{ color: 'var(--sec-text-muted)', margin: '0 auto 16px' }} />
            <p style={{ color: 'var(--sec-text-muted)' }}>No eligible promoters featured yet</p>
          </div>
        )}
      </div>
    </div>
  );
}
