import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('storage_samples')
export class StorageSample {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  databaseId!: string;

  @Column({ nullable: true })
  projectId?: string;

  @Column({ type: 'integer', default: 0 })
  sizeBytes!: number;

  @Index()
  @Column({ type: 'datetime' })
  sampledAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
