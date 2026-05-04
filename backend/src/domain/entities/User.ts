import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { UserRole } from './UserRole';
import { Session } from './Session';
import { Project } from './Project';
import { AuditLog } from './AuditLog';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ default: true })
  active!: boolean;

  @OneToMany(() => UserRole, (userRole) => userRole.user)
  roles!: UserRole[];

  @OneToMany(() => Session, (session) => session.user)
  sessions!: Session[];

  @OneToMany(() => Project, (project) => project.owner)
  ownedProjects!: Project[];

  @OneToMany(() => AuditLog, (audit) => audit.actor)
  auditLogs!: AuditLog[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
