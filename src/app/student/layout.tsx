import { Shell } from "@/components/Shell";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return <Shell role="STUDENT">{children}</Shell>;
}
