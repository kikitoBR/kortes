import { Button } from "@/components/ui/button";
import { KortesLoading } from "@/components/kortes-loader";

export function PageLoading() {
  return <KortesLoading className="min-h-[60vh]" size={72} />;
}

export function PageError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-4 px-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">Algo deu errado</h1>
      <p className="text-muted-foreground">{message}</p>
      {retry && <Button variant="outline" onClick={retry}>Tentar novamente</Button>}
    </div>
  );
}
