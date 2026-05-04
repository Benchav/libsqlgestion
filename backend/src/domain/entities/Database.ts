import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { Project } from './Project';

@Entity('databases')
export class Database {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Index()
  @Column()
  type!: string; // sqlite | libsql | remote

  @Column({ nullable: true })
  url?: string;

  @Column({ nullable: true })
  encryptedToken?: string;

  @Column({ nullable: true })
  subdomain?: string;

  @Column({ default: 'inactive' })
  status!: 'inactive' | 'active' | 'error';

  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown>;

  @ManyToOne(() => Project)
  project!: Project;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
