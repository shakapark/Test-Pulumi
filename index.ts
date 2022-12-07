import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";

const managedPolicyArns: string[] = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

// Function to create Multiple Role for different ManageNodeGroup
function createRole(name: string): aws.iam.Role {
    const role = new aws.iam.Role(name, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "ec2.amazonaws.com",
        }),
    });

    let counter = 0;
    for (const policy of managedPolicyArns) {
        // Create RolePolicyAttachment without returning it.
        const rpa = new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`,
            { policyArn: policy, role: role },
        );
    }

    return role;
};

const fixedManagedNodeRole = createRole("FixedManagedNodeRole");
const spotManagedNodeRole = createRole("SpotManagedNodeRole");

// Create a VPC for our cluster.
const vpc = new awsx.ec2.Vpc("vpc-test", {
    cidrBlock: "172.16.0.0/16",
    subnetSpecs: [
        { type: "Public", cidrMask: 20 },
        { type: "Private", cidrMask: 20 },
    ],
    numberOfAvailabilityZones: 3,
});

// Create the EKS cluster itself and a deployment of the Kubernetes dashboard.
const cluster = new eks.Cluster("cluster-test", {
    vpcId: vpc.vpcId,
    subnetIds: vpc.privateSubnetIds,
    skipDefaultNodeGroup: true,
    instanceRoles: [fixedManagedNodeRole, spotManagedNodeRole],
});

// Create ManageNodeGroups
const fixedNodeGroup = new eks.ManagedNodeGroup("fixedNodeGroup", {
    cluster: cluster,
    capacityType: "ON_DEMAND",
    instanceTypes: ["t2.micro"],
    nodeRole: fixedManagedNodeRole,
    scalingConfig: {
        desiredSize: 1,
        minSize: 1,
        maxSize: 2,
    },
});
const spotNodeGroup = new eks.ManagedNodeGroup("spotNodeGroup", {
    cluster: cluster,
    capacityType: "SPOT",
    instanceTypes: ["t2.micro"],
    nodeRole: spotManagedNodeRole,
    scalingConfig: {
        desiredSize: 1,
        minSize: 1,
        maxSize: 2,
    },
    taints: [
        {key: "spot", value: "true", effect: "NO_SCHEDULE"},
    ]
});

// Create SecurityGroup for Database
const eksToRDS = new aws.ec2.SecurityGroup("eksToRDS", {
    description: "Allow EKS Node connection to RDS",
    vpcId: vpc.vpcId,
    ingress: [{
        description: "Postgres from EKSNode",
        fromPort: 5432,
        toPort: 5432,
        protocol: "tcp",
        // securityGroups: [cluster.nodeSecurityGroup.id],
        cidrBlocks: ["172.16.0.0/16"],
    }],
    egress: [],
});

// Create RDS SubnetGroup
const rdsSubnetGroup = new aws.rds.SubnetGroup("rds-subnetgroup-test", {
    subnetIds: vpc.privateSubnetIds,
    name: "rds-subnetgroup-test",
});

// Create RDS Instance
const rds = new aws.rds.Instance("rds-test", {
    allocatedStorage: 10,
    dbName: "test",
    engine: "postgres",
    engineVersion: "14.5",
    instanceClass: "db.t3.micro",
    parameterGroupName: "default.postgres14",
    username: "postgres",
    password: "postgres",
    dbSubnetGroupName: "rds-subnetgroup-test",
    publiclyAccessible: false,
    vpcSecurityGroupIds: [eksToRDS.id],
    skipFinalSnapshot: true,
    multiAz: false,
    deletionProtection: false,                  // Set to true for Production
});


// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;