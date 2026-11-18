import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('query_metrics')
export class QueryMetric {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  databaseId!: string;

  @Column({ nullable: true })
  projectId?: string;

  @Column()
  source!: string;

  @Column()
  operation!: string;

  @Index()
  @Column()
  sqlFingerprint!: string;

  @Column({ type: 'text' })
  sqlPreview!: string;

  @Column({ type: 'integer', default: 0 })
  durationMs!: number;

  @Column({ type: 'integer', default: 0 })
  rowsRead!: number;

  @Column({ type: 'integer', default: 0 })
  rowsWritten!: number;

  @Column({ default: true })
  success!: boolean;

  @Column({ nullable: true })
  errorCode?: string;

  @Index()
  @CreateDateColumn()
  createdAt!: Date;
}
