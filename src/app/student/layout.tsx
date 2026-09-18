import { Shell } from "@/components/Shell";
import { SubscriptionProvider, SubscriptionBanner, SubscriptionLock } from "@/components/Subscription";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <SubscriptionProvider>
      <Shell role="STUDENT">
        <SubscriptionBanner />
        <SubscriptionLock />
        {children}
      </Shell>
    </SubscriptionProvider>
  );
}
