import { Shell } from "@/components/Shell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <Shell role="SCHOOL_ADMIN">{children}</Shell>;
}
