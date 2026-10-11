ALTER TABLE "Feed" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'RSS';

CREATE INDEX "Feed_sourceKind_idx" ON "Feed"("sourceKind");
