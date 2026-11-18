import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type DatabaseSnapshotStatus = 'pending' | 'ready' | 'failed' | 'deleted';
export type DatabaseSnapshotReason = 'scheduled' | 'manual' | 'pre_restore';

@Entity('database_snapshots')
export class DatabaseSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  databaseId!: string;

  @Column()
  projectId!: string;

  @Index()
  @Column()
  status!: DatabaseSnapshotStatus;

  @Column()
  reason!: DatabaseSnapshotReason;

  @Column()
  filePath!: string;

  @Column()
  fileName!: string;

  @Column({ type: 'integer', default: 0 })
  sizeBytes!: number;

  @Column({ nullable: true })
  checksumSha256?: string;

  @Column({ type: 'datetime' })
  takenAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  expiresAt?: Date | null;

  @Column({ default: false })
  pinned!: boolean;

  @Column({ nullable: true })
  errorMessage?: string;

  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
