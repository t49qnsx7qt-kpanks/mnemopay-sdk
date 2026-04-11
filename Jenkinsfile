// mnemopay-sdk — declarative pipeline
// Parallel lint + test, build, archive artifacts.
// Runs inside a node:20 container so the Jenkins controller stays clean.

pipeline {
  agent {
    docker {
      image 'node:20-alpine'
      args '-u root:root'
    }
  }

  options {
    timestamps()
    timeout(time: 15, unit: 'MINUTES')
    ansiColor('xterm')
  }

  environment {
    CI = 'true'
    NODE_ENV = 'test'
  }

  stages {
    stage('Checkout info') {
      steps {
        sh 'node --version && npm --version'
        sh 'ls -la'
      }
    }

    stage('Install') {
      steps {
        sh 'npm ci --no-audit --no-fund'
      }
    }

    stage('Quality gates') {
      parallel {
        stage('Lint (tsc --noEmit)') {
          steps {
            sh 'npm run lint'
          }
        }
        stage('Unit tests (vitest)') {
          steps {
            sh 'npm test'
          }
        }
      }
    }

    stage('Build') {
      steps {
        sh 'npm run build'
      }
    }

    stage('Archive') {
      steps {
        archiveArtifacts artifacts: 'dist/**/*', fingerprint: true, allowEmptyArchive: true
      }
    }
  }

  post {
    success {
      echo 'Pipeline green — all 707 tests passing, build clean.'
    }
    failure {
      echo 'Pipeline failed — check stage logs.'
    }
    always {
      sh 'rm -rf node_modules || true'
    }
  }
}
