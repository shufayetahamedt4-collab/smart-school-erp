import { Shell } from "@/components/Shell";
import { SubscriptionProvider, SubscriptionBanner, SubscriptionLock } from "@/components/Subscription";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SubscriptionProvider>
      <Shell role="SCHOOL_ADMIN">
        <SubscriptionBanner />
        <SubscriptionLock />
        {children}
      </Shell>
    </SubscriptionProvider>
  );
}
